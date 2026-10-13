"use strict";

console.log("[GMR][SW] service worker loaded");

// Allowed states: idle, starting, capturing, stopping (reserved for STOP).
let captureState = "idle";
let activeCaptureTabId = null;
let activeCaptureTabUrl = null;
let startOperation = null;
let stopOperation = null;
console.log("[GMR][SW] initial capture state:", captureState);

const DEFAULT_SETTINGS = {
  recordingMode: "audio",
  microphoneEnabled: true,
  saveMode: "downloads"
};

function normalizeSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  return {
    recordingMode: ["audio", "audio-video"].includes(settings.recordingMode)
      ? settings.recordingMode : DEFAULT_SETTINGS.recordingMode,
    microphoneEnabled: typeof settings.microphoneEnabled === "boolean"
      ? settings.microphoneEnabled : DEFAULT_SETTINGS.microphoneEnabled,
    saveMode: ["downloads", "ask", "selected-folder"].includes(settings.saveMode)
      ? settings.saveMode : DEFAULT_SETTINGS.saveMode
  };
}

async function getRecordingSettings() {
  try {
    const result = await chrome.storage.local.get("gmrSettings");
    const stored = result.gmrSettings || {};
    console.log("[GMR][SW] raw stored settings:", {
      recordingMode: stored.recordingMode,
      microphoneEnabled: stored.microphoneEnabled,
      saveMode: stored.saveMode
    });
    const settings = normalizeSettings({
      recordingMode: stored.recordingMode ?? DEFAULT_SETTINGS.recordingMode,
      microphoneEnabled: stored.microphoneEnabled ?? DEFAULT_SETTINGS.microphoneEnabled,
      saveMode: stored.saveMode ?? DEFAULT_SETTINGS.saveMode
    });
    console.log("[GMR][SW] resolved recording settings:", settings);
    return settings;
  } catch (error) {
    console.error("[GMR][SW] settings load failed; using defaults:", error);
    return { ...DEFAULT_SETTINGS };
  }
}

let offscreenCreationPromise = null;

async function ensureOffscreenDocument() {
  if (offscreenCreationPromise) return offscreenCreationPromise;

  offscreenCreationPromise = (async () => {
    const filter = {
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("offscreen.html")]
    };
    const contexts = await chrome.runtime.getContexts(filter);
    if (contexts.length > 0) {
      console.log("[GMR][SW] offscreen document already exists");
      return;
    }

    console.log("[GMR][SW] creating offscreen document");
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Capture meeting tab media for local recording"
      });
      console.log("[GMR][SW] offscreen document created");
    } catch (error) {
      // Another request may have created the document in the meantime.
      const existingContexts = await chrome.runtime.getContexts(filter);
      if (existingContexts.length > 0) {
        console.log("[GMR][SW] offscreen document already exists");
        return;
      }
      console.error("[GMR][SW] offscreen document creation failed:", error);
      throw error;
    }
  })();

  try {
    await offscreenCreationPromise;
  } finally {
    offscreenCreationPromise = null;
  }
}

async function handleStartRecording(sender, message) {
  if (stopOperation) return { ok: false, stage: "capture-state", state: "stopping", message: "Capture is stopping" };
  // A real in-flight request must not be mistaken for stale starting state.
  if (startOperation) {
    console.warn("[GMR][SW] start ignored: capture is already starting");
    return { ok: false, stage: "capture-state", state: "starting", message: "Capture is already starting" };
  }
  startOperation = (async () => {
    const status = await getOffscreenCaptureStatus();
    // Preserve a stopped recording awaiting a download retry.
    if (!status.hasPendingRecording && captureState === "capturing" &&
        status.hasTabStream === false && status.recorderState !== "recording") {
      console.log("[GMR][SW] stale capture state detected, resetting to idle");
      captureState = "idle";
      activeCaptureTabId = null;
      activeCaptureTabUrl = null;
    }
    if (!status.hasPendingRecording && captureState === "starting" &&
        status.hasTabStream === false && status.recorderState === "none") {
      console.log("[GMR][SW] stale starting state detected, resetting to idle");
      captureState = "idle";
      activeCaptureTabId = null;
      activeCaptureTabUrl = null;
    }
    if (captureState === "idle" && (status.hasTabStream || status.recorderState === "recording" || status.hasPendingRecording)) {
      captureState = "capturing";
      activeCaptureTabId = status.tabId ?? null;
      activeCaptureTabUrl = status.tabUrl || null;
    }
    // Recover only when Chrome proves the old Zoom document is gone.
    const recovered = await recoverZoomFrame(status);
    if (recovered?.ok === false) return recovered;
    return await performStartRecording(sender, message);
  })();
  try {
    return await startOperation;
  } finally {
    startOperation = null;
  }
}

async function performStartRecording(sender, message) {
  console.log("[GMR][SW] START_RECORDING received");
  const tabId = sender?.tab?.id;
  if (captureState === "starting") {
    console.warn("[GMR][SW] start ignored: capture is already starting");
    return { ok: false, stage: "capture-state", state: captureState, message: "Capture is already starting" };
  }
  if (captureState === "capturing") {
    console.warn("[GMR][SW] start ignored: tab capture already active");
    return { ok: false, stage: "capture-state", state: captureState, activeCaptureTabId, message: "Tab capture already active" };
  }
  if (captureState === "stopping") {
    return { ok: false, stage: "capture-state", state: captureState, message: "Capture is stopping" };
  }
  if (tabId === undefined || tabId === null) {
    console.warn("[GMR][SW] sender tab id unavailable");
    console.error("[GMR][SW] cannot start capture: sender tab id unavailable");
    return { ok: false, stage: "tab-id", message: "Sender tab id unavailable" };
  }

  console.log("[GMR][SW] sender tab id:", tabId);
  const tabUrl = sender?.tab?.url;
  const tabIdentity = getRecordingIdentity(tabUrl);
  // Zoom controls run in a meeting iframe; capture still targets sender.tab.id.
  // Retain its URL in the existing recording context for filenames/restoration.
  const recordingUrl = tabIdentity?.platform === "zoom" ? sender.url : tabUrl;
  const identity = getRecordingIdentity(recordingUrl);
  if (!identity || identity.platform !== tabIdentity?.platform ||
      (message?.platform && message.platform !== identity.platform) ||
      (message?.meetingId && message.meetingId !== identity.meetingId)) {
    return { ok: false, stage: "platform", message: "Unsupported or mismatched recording platform" };
  }
  console.log("[GMR][SW] recording platform:", identity.platform);

  captureState = "starting";
  activeCaptureTabId = tabId;
  activeCaptureTabUrl = recordingUrl || null;
  console.log("[GMR][SW] capture state: idle -> starting");
  try {
    const settings = await getRecordingSettings();
    console.log("[GMR][SW] recording settings:", settings);
    const capturedTabs = await chrome.tabCapture.getCapturedTabs();
    const existing = capturedTabs.find((item) =>
      item.tabId === tabId && (item.status === "active" || item.status === "pending")
    );
    if (existing) {
      console.warn("[GMR][SW] Chrome reports existing tab capture:", {
        tabId: existing.tabId,
        status: existing.status
      });
      captureState = "capturing";
      activeCaptureTabId = tabId;
      activeCaptureTabUrl = recordingUrl || null;
      return { ok: false, stage: "capture-state", state: "capturing", message: "Tab capture already active" };
    }
    console.log("[GMR][SW] requesting tab capture stream ID for tab:", tabId);
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId
    });
    if (typeof streamId !== "string" || streamId.length === 0) {
      throw new Error("Tab capture returned an invalid stream ID");
    }

    console.log("[GMR][SW] stream ID obtained");
    console.log("[GMR][SW] stream ID length:", streamId.length);
    try {
      await ensureOffscreenDocument();
      console.log("[GMR][SW] sending stream ID to offscreen document");
      const response = await chrome.runtime.sendMessage({
        type: "PREPARE_CAPTURE",
        target: "offscreen",
        tabId, tabUrl: activeCaptureTabUrl,
        recordingFrame: identity.platform === "zoom" ? {
          frameId: sender.frameId, documentId: sender.documentId
        } : null,
        streamId,
        settings
      });
      if (response?.ok === true && response?.stage === "recording") {
        console.log("[GMR][SW] recording started with settings:", settings);
        console.log("[GMR][SW] recording tracks:", {
          audio: response.audioTracks, video: response.videoTracks
        });
        console.log("[GMR][SW] active capture tab stored");
        console.log("[GMR][SW] MediaRecorder started in offscreen");
        console.log("[GMR][SW] recorder state:", response.recorderState);
        console.log("[GMR][SW] recorder mimeType:", response.mimeType);
        captureState = "capturing";
        activeCaptureTabId = tabId;
        activeCaptureTabUrl = recordingUrl || null;
        console.log("[GMR][SW] capture state: starting -> capturing");
        return { ok: true, stage: "recording", state: "capturing", message: "Recording started" };
      }
      if (response?.ok === true && response?.stage === "audio-mix-ready") {
        console.log("[GMR][SW] audio mix ready in offscreen");
        console.log("[GMR][SW] tab audio tracks:", response.tabAudioTrackCount);
        console.log("[GMR][SW] microphone audio tracks:", response.micAudioTrackCount);
        console.log("[GMR][SW] mixed audio tracks:", response.mixedAudioTrackCount);
        console.log("[GMR][SW] AudioContext state:", response.audioContextState);
        captureState = "capturing";
        activeCaptureTabId = tabId;
        activeCaptureTabUrl = recordingUrl || null;
        console.log("[GMR][SW] capture state: starting -> capturing");
        return { ok: true, stage: "audio-mix-ready", state: "capturing", message: "Audio sources ready" };
      }
      if (response?.ok === true && response?.stage === "tab-media-ready") {
        console.log("[GMR][SW] offscreen document accepted stream ID");
        console.log("[GMR][SW] tab MediaStream ready in offscreen");
        console.log("[GMR][SW] tab audio tracks:", response.audioTrackCount);
        captureState = "capturing";
        activeCaptureTabId = tabId;
        activeCaptureTabUrl = recordingUrl || null;
        console.log("[GMR][SW] capture state: starting -> capturing");
        return { ok: true, stage: "tab-media-ready", state: "capturing", message: "Tab audio MediaStream ready" };
      }
      if (response?.ok === true && response?.stage === "sources-ready") {
        console.log("[GMR][SW] offscreen document accepted stream ID");
        console.log("[GMR][SW] tab MediaStream ready in offscreen");
        console.log("[GMR][SW] tab and microphone sources ready");
        console.log("[GMR][SW] tab audio tracks:", response.tabAudioTrackCount);
        console.log("[GMR][SW] microphone audio tracks:", response.micAudioTrackCount);
        captureState = "capturing";
        activeCaptureTabId = tabId;
        activeCaptureTabUrl = recordingUrl || null;
        console.log("[GMR][SW] capture state: starting -> capturing");
        return { ok: true, stage: "sources-ready", state: "capturing", message: "Tab audio and microphone ready" };
      }
      if (response?.stage === "capture-state" && response?.state === "capturing") {
        captureState = "capturing";
        return { ok: false, stage: "capture-state", state: "capturing", message: response.message };
      }
      if (response?.stage === "microphone") {
        console.error("[GMR][SW] microphone preparation failed:", response?.message);
      }
      console.error("[GMR][SW] offscreen preparation failed:", response);
      return {
        ok: false,
        stage: response?.stage || "offscreen",
        message: response?.message || "Offscreen preparation failed"
      };
    } catch (error) {
      console.error("[GMR][SW] offscreen preparation failed:", error);
      return {
        ok: false,
        stage: "offscreen",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  } catch (error) {
    console.error("[GMR][SW] getMediaStreamId failed:", error);
    return {
      ok: false,
      stage: "tab-capture",
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (captureState === "starting") {
      captureState = "idle";
      activeCaptureTabId = null;
      console.log("[GMR][SW] capture state reset to idle after start failure");
      activeCaptureTabUrl = null;
    }
  }
}

function getRecordingIdentity(tabUrl) {
  try {
    const url = new URL(tabUrl);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "meet.google.com") {
      const match = url.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/i);
      return { platform: "meet", label: "Meet", meetingId: match?.[1] || "meeting" };
    }
    if (url.hostname === "app.zoom.us") {
      const match = url.pathname.match(/^\/wc\/(\d+)\/(?:join|start)\/?$/);
      return { platform: "zoom", label: "Zoom", meetingId: match?.[1] || "meeting" };
    }
    if (url.hostname === "teams.live.com") {
      const match = url.pathname.match(/^\/meet\/(\d+)\/?$/);
      return { platform: "teams", label: "Teams", meetingId: match?.[1] || "meeting" };
    }
  } catch {
    // Invalid URLs are not supported recording pages.
  }
  return null;
}

function buildRecordingFilename(tabUrl) {
  const identity = getRecordingIdentity(tabUrl);
  const label = identity?.label || "Meet";
  const meetingCode = identity?.meetingId || "meeting";
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `${label}_${meetingCode}_${stamp}.webm`.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

async function getOffscreenCaptureStatus() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  if (!contexts.length) {
    return { hasTabStream: false, hasMicStream: false, hasMixedStream: false, recorderState: "none" };
  }
  const response = await chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATUS", target: "offscreen" });
  if (response?.ok !== true || response.stage !== "capture-status") {
    throw new Error("Offscreen capture status unavailable");
  }
  console.log("[GMR][SW] offscreen capture status:", {
    hasTabStream: response.hasTabStream,
    hasMicStream: response.hasMicStream,
    hasMixedStream: response.hasMixedStream,
    recorderState: response.recorderState
  });
  return response;
}

async function restoreCaptureState() {
  if (captureState !== "idle") return;
  const status = await getOffscreenCaptureStatus();
  if (captureState === "idle" && (status.hasTabStream || status.recorderState === "recording" || status.hasPendingRecording) && Number.isInteger(status.tabId)) {
    captureState = "capturing";
    activeCaptureTabId = status.tabId;
    activeCaptureTabUrl = status.tabUrl || null;
    console.log("[GMR][SW] active capture state restored from offscreen");
  }
}

async function handleStopRecording(sender) {
  console.log("[GMR][SW] STOP_RECORDING received");
  return await stopAndSaveRecording("manual");
}

async function stopAndSaveRecording(reason) {
  if (stopOperation) {
    console.log("[GMR][SW] stop ignored: already stopping");
    return stopOperation;
  }
  stopOperation = (async () => {
    await restoreCaptureState();
    if (captureState === "starting" && startOperation) await startOperation;
    if (captureState === "idle") {
      console.warn("[GMR][SW] stop ignored: capture already idle");
      return { ok: true, stage: "recording-saved", state: "idle", message: "Recording already stopped" };
    }
    const recordingTabUrl = activeCaptureTabUrl;
    captureState = "stopping";
    console.log("[GMR][SW] capture state: capturing -> stopping");
    console.log("[GMR][SW] stopping recording, reason:", reason);
    let stage = "stop-capture";
    try {
      // Query offscreen even after worker suspension reset its in-memory state.
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL("offscreen.html")]
      });
      if (contexts.length === 0) {
        captureState = "idle";
        activeCaptureTabId = null;
        activeCaptureTabUrl = null;
        return { ok: false, stage, state: "idle", message: "No offscreen recording available to save" };
      }
      console.log("[GMR][SW] sending STOP_CAPTURE to offscreen");
      const response = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE", target: "offscreen" });
      if (response?.ok !== true || response?.stage !== "recording-ready-to-save") {
        console.error("[GMR][SW] STOP_CAPTURE failed:", {
          stage: response?.stage, message: response?.message
        });
        captureState = response?.state === "idle" ? "idle" : "capturing";
        if (captureState === "idle") { activeCaptureTabId = null; activeCaptureTabUrl = null; }
        return { ok: false, stage: response?.stage || stage, state: captureState, message: response?.message || "Failed to stop recording" };
      }
      console.log("[GMR][SW] offscreen capture stopped");
      stage = "download";
      const filename = buildRecordingFilename(recordingTabUrl);
      console.log("[GMR][SW] recording ready for download");
      console.log("[GMR][SW] recording blob size:", response.blobSize);
      console.log("[GMR][SW] download filename:", filename);
      // Use the snapshot held with the Blob, including after worker suspension.
      const saveMode = normalizeSettings(response.settings).saveMode;
      console.log("[GMR][SW] save mode:", saveMode);
      let folderSaved = false;
      if (saveMode === "selected-folder") {
        console.log("[GMR][SW] sending recording to selected folder");
        try {
          const saved = await chrome.runtime.sendMessage({
            type: "SAVE_TO_SELECTED_FOLDER", target: "offscreen",
            blobUrl: response.blobUrl, filename
          });
          folderSaved = saved?.ok === true && saved.stage === "saved-selected-folder";
        } catch (error) {
          console.error("[GMR][SW] selected folder message failed:", error);
        }
        if (folderSaved) {
          console.log("[GMR][SW] recording saved to selected folder");
        } else {
          console.warn("[GMR][SW] selected folder unavailable, falling back to save dialog");
        }
      }
      if (!folderSaved) {
        const downloadId = await chrome.downloads.download({
          url: response.blobUrl, filename, saveAs: saveMode !== "downloads"
        });
        if (!Number.isInteger(downloadId)) throw new Error("Download did not return an ID");
        console.log("[GMR][SW] download started");
        console.log("[GMR][SW] download id:", downloadId);
      }
      try {
        const revoked = await chrome.runtime.sendMessage({
          type: "REVOKE_BLOB_URL", target: "offscreen", blobUrl: response.blobUrl
        });
        if (!revoked?.ok) console.warn("[GMR][SW] Blob URL cleanup not confirmed");
      } catch (error) {
        console.error("[GMR][SW] Blob URL cleanup failed:", error);
      }
      captureState = "idle";
      activeCaptureTabId = null;
      activeCaptureTabUrl = null;
      console.log("[GMR][SW] capture state: stopping -> idle");
      console.log("[GMR][SW] active capture tab cleared");
      return { ok: true, stage: "recording-saved", state: "idle", message: "Recording saved" };
    } catch (error) {
      console.error(stage === "download" ? "[GMR][SW] download failed" : "[GMR][SW] STOP_CAPTURE failed:", error);
      // Offscreen retains the Blob URL after download failure for a manual retry.
      captureState = "capturing";
      return { ok: false, stage, state: captureState, message: error instanceof Error ? error.message : String(error) };
    }
  })();
  try {
    return await stopOperation;
  } finally {
    stopOperation = null;
  }
}

// Offscreen retains frame identity across worker suspension, including pending saves.
function isZoomStatus(status) {
  return status.active && getRecordingIdentity(status.tabUrl)?.platform === "zoom" &&
    Number.isInteger(status.recordingFrame?.frameId) && Boolean(status.recordingFrame?.documentId);
}

async function stopZoomFrame(status) {
  // Recheck identity after asynchronous work so a delayed old event cannot stop a new recording.
  const current = await getOffscreenCaptureStatus();
  if (!isZoomStatus(current) || current.tabId !== status.tabId ||
      current.recordingFrame.documentId !== status.recordingFrame.documentId) return;
  console.log("[GMR][SW][ZOOM] stopping active recording after frame exit");
  const result = await stopAndSaveRecording("zoom-frame-exit");
  if (result.ok) {
    console.log("[GMR][SW][ZOOM] recording saved after frame exit");
    console.log("[GMR][SW] capture state: idle");
  }
  return result;
}

async function recoverZoomFrame(status, expectedTabId) {
  if (!isZoomStatus(status) || (expectedTabId !== undefined && status.tabId !== expectedTabId)) return;
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: status.tabId });
  } catch {
    // An unavailable inventory is not proof that the recording frame disappeared.
    return;
  }
  if (!Array.isArray(frames)) return;
  const frame = frames.find((item) => item.frameId === status.recordingFrame.frameId &&
    item.documentId === status.recordingFrame.documentId);
  const identity = frame && getRecordingIdentity(frame.url);
  const previous = getRecordingIdentity(status.tabUrl);
  if (frame && identity?.platform === "zoom" && identity.meetingId !== "meeting" &&
      identity.meetingId === previous.meetingId) return;
  return await stopZoomFrame(status);
}

async function checkZoomFrame(tabId) {
  if (startOperation) await startOperation;
  return await recoverZoomFrame(await getOffscreenCaptureStatus(), tabId);
}

async function handleZoomFrameLeft(sender) {
  console.log("[GMR][SW][ZOOM] meeting frame left");
  if (startOperation) await startOperation;
  const status = await getOffscreenCaptureStatus();
  if (!isZoomStatus(status) || status.tabId !== sender?.tab?.id ||
      status.recordingFrame.frameId !== sender.frameId ||
      status.recordingFrame.documentId !== sender.documentId) return { ok: true, ignored: true };
  return await stopZoomFrame(status);
}

function scheduleZoomFrameCheck(tabId) {
  checkZoomFrame(tabId).catch((error) => console.error("[GMR][SW][ZOOM] frame check failed", error));
}

chrome.webNavigation.onCommitted.addListener((details) => scheduleZoomFrameCheck(details.tabId));
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => scheduleZoomFrameCheck(details.tabId));
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "zoom-meeting-lifecycle" ||
      getRecordingIdentity(port.sender?.url)?.platform !== "zoom") return;
  const tabId = port.sender?.tab?.id;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    scheduleZoomFrameCheck(tabId);
    // Frame removal and port disconnect can race; one bounded retry, no polling.
    setTimeout(() => scheduleZoomFrameCheck(tabId), 1000);
  });
});

async function handleMeetingLeft(sender) {
  console.log("[GMR][SW] MEETING_LEFT received");
  await restoreCaptureState();
  if (getRecordingIdentity(activeCaptureTabUrl)?.platform === "zoom") {
    return await handleZoomFrameLeft(sender);
  }
  if (sender?.tab?.id !== activeCaptureTabId || activeCaptureTabId === null) {
    console.warn("[GMR][SW] MEETING_LEFT ignored: not active capture tab");
    return { ok: false, stage: "meeting-left", message: "Message came from non-active capture tab" };
  }
  return await stopAndSaveRecording("meeting-left");
}

chrome.tabs.onRemoved.addListener((tabId) => {
  console.log("[GMR][SW] tab removed:", tabId);
  (async () => {
    try {
      await restoreCaptureState();
      if (tabId !== activeCaptureTabId || !["starting", "capturing", "stopping"].includes(captureState)) return;
      console.log("[GMR][SW] active recording tab closed during recording");
      const result = await stopAndSaveRecording("tab-closed");
      if (!result.ok) throw new Error(`${result.stage}: ${result.message}`);
      console.log("[GMR][SW] recording saved after tab close");
    } catch (error) {
      console.error("[GMR][SW] failed to save after tab close:", error);
    }
  })();
});

function getMeetingCodeFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname === "teams.live.com") {
      return parsed.pathname.match(/^\/meet\/(\d+)\/?$/)?.[1] || null;
    }
    if (parsed.hostname !== "meet.google.com") return null;
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(path) ? path.toLowerCase() : null;
  } catch {
    return null;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  (async () => {
    try {
      await restoreCaptureState();
      if (tabId !== activeCaptureTabId || !["starting", "capturing", "stopping"].includes(captureState)) return;
      const previousCode = getMeetingCodeFromUrl(activeCaptureTabUrl);
      const newCode = getMeetingCodeFromUrl(changeInfo.url);
      const previousPlatform = getRecordingIdentity(activeCaptureTabUrl)?.platform;
      const nextPlatform = getRecordingIdentity(changeInfo.url)?.platform;
      let reason;
      if (!nextPlatform || nextPlatform !== previousPlatform) {
        console.log("[GMR][SW] active recording tab navigated away from its platform");
        reason = "navigation";
      } else if (previousCode && newCode && previousCode !== newCode) {
        console.log("[GMR][SW] active recording tab changed meeting code", { previousCode, newCode });
        reason = "meeting-changed";
      } else {
        return;
      }
      const result = await stopAndSaveRecording(reason);
      if (!result.ok) throw new Error(`${result.stage}: ${result.message}`);
    } catch (error) {
      console.error("[GMR][SW] failed to save after navigation:", error);
    }
  })();
});

// A closed response channel must not cause an unhandled Promise rejection.
function respondSafely(sendResponse, response) {
  try {
    sendResponse(response);
  } catch (error) {
    console.error("[GMR][SW] message handling failed", error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message?.type === "SAVE_TO_SELECTED_FOLDER" || message?.type === "PREPARE_CAPTURE" || message?.type === "STOP_CAPTURE" || message?.type === "REVOKE_BLOB_URL" || message?.type === "GET_CAPTURE_STATUS") return false;
    if (message?.type === "ZOOM_MEETING_FRAME_LEFT") {
      handleZoomFrameLeft(sender)
        .then((response) => respondSafely(sendResponse, response || { ok: true, ignored: true }))
        .catch((error) => {
          console.error("[GMR][SW][ZOOM] frame exit save failed", error);
          respondSafely(sendResponse, { ok: false, message: String(error) });
        });
      return true;
    }
    if (message?.type === "MEETING_LEFT") {
      handleMeetingLeft(sender)
        .then((response) => respondSafely(sendResponse, response))
        .catch((error) => {
          console.error("[GMR][SW] meeting-left save failed:", error);
          respondSafely(sendResponse, { ok: false, stage: "auto-stop", message: String(error) });
        });
      return true;
    }
    if (message?.type === "STOP_RECORDING") {
      handleStopRecording(sender)
        .then((response) => respondSafely(sendResponse, response))
        .catch((error) => {
          console.error("[GMR][SW] STOP_CAPTURE failed:", error);
          respondSafely(sendResponse, {
            ok: false, stage: "stop-capture", state: captureState,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      return true;
    }
    if (message?.type !== "START_RECORDING") {
      console.warn("[GMR][SW] unknown message type:", message?.type);
      return false;
    }

    handleStartRecording(sender, message)
      .then((response) => respondSafely(sendResponse, response))
      .catch((error) => {
        console.error("[GMR][SW] START_RECORDING failed", error);
        respondSafely(sendResponse, {
          ok: false,
          stage: "unknown",
          message: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  } catch (error) {
    console.error("[GMR][SW] message handling failed", error);
    respondSafely(sendResponse, { ok: false, message: "Service worker error" });
    return false;
  }
});

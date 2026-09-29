"use strict";

console.log("[GMR][OFFSCREEN] offscreen document loaded");

let tabStream = null;
let micStream = null;
let mixedStream = null;
let finalRecordingStream = null;
let recordingSettings = null;
let audioContext = null;
let tabSourceNode = null;
let micSourceNode = null;
let mixedDestinationNode = null;
let cleanupPending = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartedAt = null;
let recorderStopped = null;
let recorderError = null;
let stopRecordingPending = false;
let pendingRecording = null;
let recordingTabId = null;
let recordingTabUrl = null;

function createMediaRecorder(settings) {
  if (!finalRecordingStream?.getAudioTracks().some((track) => track.readyState === "live")) {
    throw new Error("Cannot create MediaRecorder: mixed audio stream is not ready");
  }
  recordedChunks = [];
  recorderError = null;
  recordingStartedAt = null;
  const preferredMimeTypes = settings.recordingMode === "audio-video"
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["audio/webm;codecs=opus", "audio/webm"];
  const selectedMimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  mediaRecorder = selectedMimeType
    ? new MediaRecorder(finalRecordingStream, { mimeType: selectedMimeType })
    : new MediaRecorder(finalRecordingStream);
  console.log("[GMR][OFFSCREEN] MediaRecorder created");
  console.log("[GMR][OFFSCREEN] MediaRecorder mimeType:", mediaRecorder.mimeType);
  const chunks = recordedChunks;
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  mediaRecorder.addEventListener("error", (event) => {
    recorderError = event.error || new Error("MediaRecorder failed");
    console.error("[GMR][OFFSCREEN] MediaRecorder error:", event.error || event);
  });
  // Register before start so an automatic stop cannot be missed.
  recorderStopped = new Promise((resolve) => {
    mediaRecorder.addEventListener("stop", () => {
      console.log("[GMR][OFFSCREEN] MediaRecorder stopped");
      resolve();
    }, { once: true });
  });
}

async function stopMediaRecorder() {
  if (!mediaRecorder) return { blob: null, mimeType: null, chunkCount: 0 };
  const recorder = mediaRecorder;
  if (recorder.state !== "inactive") {
    console.log("[GMR][OFFSCREEN] stopping MediaRecorder");
    recorder.stop();
  }
  if (recordingStartedAt !== null) await recorderStopped;
  if (recorderError) throw recorderError;
  const mimeType = recorder.mimeType || (recordingSettings?.recordingMode === "audio-video" ? "video/webm" : "audio/webm");
  const chunkCount = recordedChunks.length;
  let blob;
  try {
    blob = new Blob(recordedChunks, { type: mimeType });
  } catch (error) {
    error.stage = "recording-blob";
    throw error;
  }
  console.log("[GMR][OFFSCREEN] recording Blob created");
  console.log("[GMR][OFFSCREEN] recording Blob info:", {
    size: blob.size, type: blob.type, chunkCount
  });
  if (blob.size === 0) {
    const error = new Error("Recorded Blob is empty");
    error.stage = "recording-blob";
    throw error;
  }
  return { blob, mimeType, chunkCount };
}

async function finishRecording() {
  if (prepareCapturePending || stopRecordingPending) {
    return { ok: false, stage: "capture-state", message: "Audio operation already pending" };
  }
  stopRecordingPending = true;
  let stage = "recorder-stop";
  try {
    if (!pendingRecording) {
      const { blob, chunkCount } = await stopMediaRecorder();
      stage = "recording-blob";
      if (!blob) throw new Error("No recording available to save");
      const blobUrl = URL.createObjectURL(blob);
      console.log("[GMR][OFFSCREEN] Blob URL created for download");
      pendingRecording = {
        ok: true, stage: "recording-ready-to-save",
        message: "Recording stopped and ready to save",
        blobUrl, blobSize: blob.size, mimeType: blob.type, chunkCount,
        settings: { ...recordingSettings }
      };
    }
    stage = "audio-cleanup";
    await cleanupAudioResources();
    mediaRecorder = null;
    recordedChunks = [];
    recordingStartedAt = null;
    recorderStopped = null;
    return pendingRecording;
  } catch (error) {
    stage = error.stage || stage;
    console.error("[GMR][OFFSCREEN] MediaRecorder stop failed", error);
    console.error("[GMR][OFFSCREEN] recording stop failure stage:", stage);
    let state = "capturing";
    try {
      await cleanupAudioResources();
      if (!pendingRecording) state = "idle";
      mediaRecorder = null;
      recordedChunks = [];
      recordingStartedAt = null;
      recorderStopped = null;
    } catch (cleanupError) {
      console.error("[GMR][OFFSCREEN] recording cleanup failed:", cleanupError);
    }
    return { ok: false, stage, state, message: error instanceof Error ? error.message : String(error) };
  } finally {
    stopRecordingPending = false;
  }
}
let tabStreamRequestPending = false;
let prepareCapturePending = false;

async function getTabMediaStream(streamId, settings) {
  if (typeof streamId !== "string" || streamId.length === 0) {
    console.error("[GMR][OFFSCREEN] invalid stream ID");
    return { ok: false, stage: "offscreen-validation", message: "Invalid stream ID" };
  }
  // Multiple Meet tabs share this offscreen document.
  if (tabStreamRequestPending) {
    return { ok: false, stage: "tab-media", message: "Tab audio request already pending" };
  }

  tabStreamRequestPending = true;
  let acquiredStream = null;
  try {
    if (tabStream) {
      console.log("[GMR][OFFSCREEN] stopping previous tab stream");
      tabStream.getTracks().forEach((track) => track.stop());
      tabStream = null;
    }

    console.log("[GMR][OFFSCREEN] requesting tab MediaStream");
    acquiredStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: settings.recordingMode === "audio-video" ? {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      } : false
    });
    if (!acquiredStream) throw new Error("Tab MediaStream unavailable");

    const audioTracks = acquiredStream.getAudioTracks();
    const videoTracks = acquiredStream.getVideoTracks();
    console.log("[GMR][OFFSCREEN] tab MediaStream obtained");
    console.log("[GMR][OFFSCREEN] audio tracks count:", audioTracks.length);
    console.log("[GMR][OFFSCREEN] video tracks count:", videoTracks.length);

    if (audioTracks.length === 0) {
      console.error("[GMR][OFFSCREEN] tab stream contains no audio tracks");
      acquiredStream.getTracks().forEach((track) => track.stop());
      return { ok: false, stage: "tab-media", message: "Tab stream contains no audio tracks" };
    }

    if (settings.recordingMode === "audio-video" &&
        !videoTracks.some((track) => track.readyState === "live")) {
      throw new Error("Tab stream contains no live video tracks");
    }

    for (const track of audioTracks) {
      console.log("[GMR][OFFSCREEN] audio track state:", {
        kind: track.kind,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState
      });
      track.addEventListener("ended", () => {
        console.log("[GMR][OFFSCREEN] tab audio track ended");
      });
    }
    tabStream = acquiredStream;
    return {
      ok: true,
      stage: "tab-media-ready",
      message: "Tab audio MediaStream obtained",
      audioTrackCount: audioTracks.length,
      videoTrackCount: videoTracks.length
    };
  } catch (error) {
    console.error("[GMR][OFFSCREEN] getUserMedia for tab failed:", error);
    if (acquiredStream) {
      acquiredStream.getTracks().forEach((track) => track.stop());
    }
    return {
      ok: false,
      stage: "tab-media",
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    tabStreamRequestPending = false;
  }
}

async function getMicrophoneStream() {
  let stream = null;
  try {
    if (micStream) {
      console.log("[GMR][OFFSCREEN] stopping previous microphone stream");
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }

    console.log("[GMR][OFFSCREEN] requesting microphone MediaStream");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });
    if (!stream) throw new Error("Microphone MediaStream unavailable");
    console.log("[GMR][OFFSCREEN] microphone MediaStream obtained");

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log("[GMR][OFFSCREEN] microphone audio tracks count:", audioTracks.length);
    console.log("[GMR][OFFSCREEN] microphone video tracks count:", videoTracks.length);
    if (videoTracks.length !== 0) throw new Error("Microphone stream unexpectedly contains video tracks");
    if (audioTracks.length === 0) {
      console.error("[GMR][OFFSCREEN] microphone stream contains no audio tracks");
      throw new Error("Microphone stream contains no audio tracks");
    }

    for (const track of audioTracks) {
      console.log("[GMR][OFFSCREEN] microphone track state:", {
        kind: track.kind,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState
      });
      track.addEventListener("ended", () => {
        console.log("[GMR][OFFSCREEN] microphone audio track ended");
      });
    }
    if (!audioTracks.some((track) => track.readyState === "live")) {
      throw new Error("Microphone stream contains no live audio tracks");
    }
    micStream = stream;
    return stream;
  } catch (error) {
    console.error("[GMR][OFFSCREEN] microphone getUserMedia failed:", error);
    console.error("[GMR][OFFSCREEN] microphone error details:", {
      name: error?.name,
      message: error?.message
    });
    if (stream) stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

async function createMixedAudioStream(settings) {
  if (!tabStream?.getAudioTracks().some((track) => track.readyState === "live")) {
    throw new Error("Tab stream contains no live audio tracks");
  }
  if (settings.microphoneEnabled && !micStream?.getAudioTracks().some((track) => track.readyState === "live")) {
    throw new Error("Microphone stream contains no live audio tracks");
  }
  audioContext = new AudioContext();
  console.log("[GMR][OFFSCREEN] AudioContext created");
  console.log("[GMR][OFFSCREEN] AudioContext state:", audioContext.state);
  if (audioContext.state === "suspended") {
    await audioContext.resume();
    console.log("[GMR][OFFSCREEN] AudioContext state after resume:", audioContext.state);
  }
  if (audioContext.state !== "running") throw new Error("AudioContext is not running");

  tabSourceNode = audioContext.createMediaStreamSource(tabStream);
  micSourceNode = settings.microphoneEnabled
    ? audioContext.createMediaStreamSource(micStream) : null;
  mixedDestinationNode = audioContext.createMediaStreamDestination();
  mixedStream = mixedDestinationNode.stream;
  console.log("[GMR][OFFSCREEN] audio source nodes created");
  tabSourceNode.connect(mixedDestinationNode);
  if (micSourceNode) micSourceNode.connect(mixedDestinationNode);
  console.log(settings.microphoneEnabled
    ? "[GMR][OFFSCREEN] tab and microphone connected to mixed destination"
    : "[GMR][OFFSCREEN] tab connected to mixed destination");
  // Do not connect microphone to audioContext.destination.
  // It would play the user's own microphone back and can cause echo.
  tabSourceNode.connect(audioContext.destination);
  console.log("[GMR][OFFSCREEN] tab audio connected to speakers");

  const mixedAudioTracks = mixedStream.getAudioTracks();
  console.log("[GMR][OFFSCREEN] mixed MediaStream created");
  console.log("[GMR][OFFSCREEN] mixed audio tracks count:", mixedAudioTracks.length);
  if (mixedAudioTracks.length === 0) throw new Error("Mixed MediaStream contains no audio tracks");
  const track = mixedAudioTracks[0];
  console.log("[GMR][OFFSCREEN] mixed track state:", {
    kind: track.kind, enabled: track.enabled, muted: track.muted, readyState: track.readyState
  });
  if (!mixedAudioTracks.some((item) => item.readyState === "live")) {
    throw new Error("Mixed MediaStream contains no live audio tracks");
  }
  return mixedStream;
}

async function cleanupAudioResources() {
  if (cleanupPending) throw new Error("Audio cleanup is already pending");
  cleanupPending = true;
  // Tracks are shared with tabStream/mixedStream and stopped through their owners.
  finalRecordingStream = null;
  const errors = [];
  let stoppedTrackCount = 0;
  try {
    for (const [node, label] of [
      [tabSourceNode, "tab source"],
      [micSourceNode, "microphone source"],
      [mixedDestinationNode, "mixed destination"]
    ]) {
      if (!node) continue;
      try { node.disconnect(); }
      catch (error) {
        console.warn(`[GMR][OFFSCREEN] ${label} disconnect warning:`, error?.message);
      }
    }
    tabSourceNode = null;
    micSourceNode = null;
    mixedDestinationNode = null;

    const stopTracks = (stream, label) => {
      let stopped = true;
      for (const track of stream.getTracks()) {
        try {
          if (track.readyState !== "ended") track.stop();
        } catch (error) {
          console.error(`[GMR][OFFSCREEN] ${label} track stop failed:`, error);
          errors.push(error);
          stopped = false;
        }
      }
      return stopped;
    };
    if (micStream) {
      console.log("[GMR][OFFSCREEN] stopping microphone tracks:", micStream.getTracks().length);
      if (stopTracks(micStream, "microphone")) {
        micStream = null;
        console.log("[GMR][OFFSCREEN] microphone stream stopped");
      }
    }
    if (tabStream) {
      stoppedTrackCount = tabStream.getTracks().length;
      console.log("[GMR][OFFSCREEN] stopping tab stream tracks:", stoppedTrackCount);
      if (stopTracks(tabStream, "tab")) {
        tabStream = null;
        console.log("[GMR][OFFSCREEN] tab stream stopped");
      }
    }
    if (mixedStream && stopTracks(mixedStream, "mixed")) mixedStream = null;
    if (!mixedStream) console.log("[GMR][OFFSCREEN] mixed stream cleared");
    if (audioContext) {
      try {
        if (audioContext.state !== "closed") await audioContext.close();
        console.log("[GMR][OFFSCREEN] AudioContext closed");
        audioContext = null;
      } catch (error) {
        console.error("[GMR][OFFSCREEN] AudioContext close failed:", error);
        errors.push(error);
      }
    }
    // Keep references to resources that failed to stop, so STOP can retry.
    if (errors.length) throw new Error("Some audio resources could not be released");
    return { stoppedTrackCount };
  } finally {
    cleanupPending = false;
  }
}

function hasLiveTracks(stream) {
  return Boolean(stream && stream.getTracks().some((track) => track.readyState === "live"));
}

function hasActiveTabStream() {
  return hasLiveTracks(tabStream);
}

async function prepareCapture(streamId, suppliedSettings = {}) {
  const settings = {
    recordingMode: suppliedSettings?.recordingMode === "audio-video" ? "audio-video" : "audio",
    microphoneEnabled: suppliedSettings?.microphoneEnabled !== false,
    saveMode: ["downloads", "ask", "selected-folder"].includes(suppliedSettings?.saveMode)
      ? suppliedSettings.saveMode : "downloads"
  };
  if (stopRecordingPending || pendingRecording) {
    return { ok: false, stage: "capture-state", state: "capturing", message: "Previous recording is awaiting save" };
  }
  if (cleanupPending || prepareCapturePending) {
    return { ok: false, stage: "capture-state", message: "Audio setup or cleanup already pending" };
  }
  if (hasActiveTabStream()) {
    console.log("[GMR][OFFSCREEN] tab stream already active");
    return { ok: false, stage: "capture-state", state: "capturing", message: "Tab stream already active" };
  }
  // Keep capture preparation exclusive across Meet tabs.
  prepareCapturePending = true;
  let stage = "tab-media";
  try {
    if (micStream || mixedStream || audioContext) await cleanupAudioResources();
    recordingSettings = settings;
    const tabResponse = await getTabMediaStream(streamId, settings);
    if (!tabResponse.ok) {
      console.log("[GMR][OFFSCREEN] cleaning up after audio setup failure");
      await cleanupAudioResources();
      return tabResponse;
    }
    stage = "microphone";
    if (settings.microphoneEnabled) {
      await getMicrophoneStream();
    } else {
      micStream = null;
      console.log("[GMR][OFFSCREEN] microphone disabled by settings");
    }
    stage = "audio-mix";
    await createMixedAudioStream(settings);
    finalRecordingStream = new MediaStream();
    mixedStream.getAudioTracks().forEach((track) => finalRecordingStream.addTrack(track));
    if (settings.recordingMode === "audio-video") {
      tabStream.getVideoTracks().forEach((track) => finalRecordingStream.addTrack(track));
    }
    console.log("[GMR][OFFSCREEN] final recording stream created");
    console.log("[GMR][OFFSCREEN] final recording stream tracks:", {
      audio: finalRecordingStream.getAudioTracks().length,
      video: finalRecordingStream.getVideoTracks().length
    });
    stage = "recorder-start";
    createMediaRecorder(settings);
    console.log("[GMR][OFFSCREEN] starting MediaRecorder");
    mediaRecorder.start(1000);
    recordingStartedAt = Date.now();
    console.log("[GMR][OFFSCREEN] MediaRecorder started");
    console.log("[GMR][OFFSCREEN] MediaRecorder state:", mediaRecorder.state);
    return {
      ok: true, stage: "recording",
      message: "Recording started",
      tabAudioTrackCount: tabStream.getAudioTracks().length,
      micAudioTrackCount: micStream?.getAudioTracks().length || 0,
      mixedAudioTrackCount: mixedStream.getAudioTracks().length,
      audioContextState: audioContext.state,
      recorderState: mediaRecorder.state,
      mimeType: mediaRecorder.mimeType,
      audioTracks: finalRecordingStream.getAudioTracks().length,
      videoTracks: finalRecordingStream.getVideoTracks().length,
      microphoneEnabled: settings.microphoneEnabled,
      recordingMode: settings.recordingMode
    };
  } catch (error) {
    console.error("[GMR][OFFSCREEN] audio setup failed:", error);
    console.log("[GMR][OFFSCREEN] cleaning up after audio setup failure");
    try {
      await cleanupAudioResources();
      if (stage === "microphone") {
        console.log("[GMR][OFFSCREEN] cleaned up tab stream after microphone failure");
      }
    } catch (cleanupError) {
      console.error("[GMR][OFFSCREEN] audio setup cleanup failed:", cleanupError);
    }
    return { ok: false, stage, message: error instanceof Error ? error.message : String(error) };
  } finally {
    prepareCapturePending = false;
  }
}

function stopTabStream() {
  if (!tabStream) {
    console.warn("[GMR][OFFSCREEN] no tab stream to stop");
    return { stopped: false, trackCount: 0 };
  }
  const tracks = tabStream.getTracks();
  console.log("[GMR][OFFSCREEN] stopping tab stream tracks:", tracks.length);
  for (const track of tracks) {
    if (track.readyState !== "ended") track.stop();
  }
  tabStream = null;
  console.log("[GMR][OFFSCREEN] tab stream stopped");
  return { stopped: true, trackCount: tracks.length };
}

function openFolderDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("GMRDatabase", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("handles")) {
        request.result.createObjectStore("handles");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSelectedDirectoryHandle() {
  const db = await openFolderDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const request = tx.objectStore("handles").get("selectedDirectory");
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || new Error("Directory handle read aborted"));
      tx.onerror = () => reject(tx.error || request.error);
    });
  } finally {
    db.close();
  }
}

let folderWriteOperation = null;
async function saveToSelectedFolder(blobUrl, filename) {
  if (!pendingRecording || blobUrl !== pendingRecording.blobUrl ||
      typeof filename !== "string" || !/^Meet_[^/\\]+\.webm$/.test(filename)) {
    return { ok: false, stage: "folder-validation", message: "Invalid pending recording" };
  }
  if (pendingRecording.folderSaved) return { ok: true, stage: "saved-selected-folder" };
  if (folderWriteOperation) return folderWriteOperation;
  folderWriteOperation = (async () => {
    let writable = null;
    try {
      if (typeof FileSystemDirectoryHandle === "undefined") {
        return { ok: false, stage: "folder-capability", message: "Directory API unavailable" };
      }
      const handle = await getSelectedDirectoryHandle();
      if (!handle || typeof handle.getFileHandle !== "function") {
        return { ok: false, stage: "folder-handle", message: "Selected directory unavailable" };
      }
      console.log("[GMR][OFFSCREEN] selected directory handle loaded");
      const permission = await handle.queryPermission({ mode: "readwrite" });
      console.log("[GMR][OFFSCREEN] selected folder permission:", permission);
      if (permission !== "granted") {
        console.warn("[GMR][OFFSCREEN] selected folder permission unavailable");
        return { ok: false, stage: "folder-permission", message: "Selected folder permission is not granted" };
      }
      // Minute-resolution filenames can collide: never overwrite an earlier recording.
      try {
        await handle.getFileHandle(filename);
        return { ok: false, stage: "folder-conflict", message: "Recording filename already exists" };
      } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
      }
      const response = await fetch(blobUrl);
      if (!response.ok) throw new Error("Recording Blob unavailable");
      const blob = await response.blob();
      const fileHandle = await handle.getFileHandle(filename, { create: true });
      if (typeof fileHandle.createWritable !== "function") {
        return { ok: false, stage: "folder-capability", message: "Writable file API unavailable" };
      }
      console.log("[GMR][OFFSCREEN] writing recording file:", filename);
      writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      writable = null;
      pendingRecording.folderSaved = true;
      console.log("[GMR][OFFSCREEN] recording saved to selected folder");
      return { ok: true, stage: "saved-selected-folder" };
    } catch (error) {
      if (writable) {
        try { await writable.abort(); }
        catch (abortError) { console.error("[GMR][OFFSCREEN] folder write abort failed:", abortError?.name); }
      }
      console.error("[GMR][OFFSCREEN] selected folder save failed:", error?.name);
      return { ok: false, stage: "folder-write", message: "Could not write recording to selected folder" };
    }
  })();
  try { return await folderWriteOperation; }
  finally { folderWriteOperation = null; }
}

function respondSafely(sendResponse, response) {
  try {
    sendResponse(response);
  } catch (error) {
    console.error("[GMR][OFFSCREEN] message handling failed", error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SAVE_TO_SELECTED_FOLDER" && message?.target === "offscreen") {
    console.log("[GMR][OFFSCREEN] SAVE_TO_SELECTED_FOLDER received");
    saveToSelectedFolder(message.blobUrl, message.filename)
      .then((response) => respondSafely(sendResponse, response))
      .catch((error) => {
        console.error("[GMR][OFFSCREEN] selected folder handler failed:", error?.name);
        respondSafely(sendResponse, { ok: false, stage: "folder-write", message: "Selected folder save failed" });
      });
    return true;
  }
  if (message?.type === "GET_CAPTURE_STATUS" && message?.target === "offscreen") {
    respondSafely(sendResponse, {
      ok: true, stage: "capture-status",
      hasTabStream: hasLiveTracks(tabStream),
      hasMicStream: hasLiveTracks(micStream),
      hasMixedStream: hasLiveTracks(mixedStream),
      recorderState: mediaRecorder?.state || "none",
      hasPendingRecording: Boolean(pendingRecording),
      active: Boolean(pendingRecording || hasLiveTracks(tabStream) || mediaRecorder?.state === "recording"),
      tabId: recordingTabId, tabUrl: recordingTabUrl
    });
    return false;
  }
  if (message?.type === "REVOKE_BLOB_URL" && message?.target === "offscreen") {
    try {
      if (pendingRecording && message.blobUrl === pendingRecording.blobUrl) {
        URL.revokeObjectURL(message.blobUrl);
        pendingRecording = null;
        recordingSettings = null;
        recordingTabId = null;
        recordingTabUrl = null;
        console.log("[GMR][OFFSCREEN] Blob URL revoked");
      }
      respondSafely(sendResponse, { ok: true });
    } catch (error) {
      console.error("[GMR][OFFSCREEN] Blob URL revoke failed:", error);
      respondSafely(sendResponse, { ok: false, message: "Blob URL revoke failed" });
    }
    return false;
  }
  if (message?.type === "STOP_CAPTURE" && message?.target === "offscreen") {
    console.log("[GMR][OFFSCREEN] STOP_CAPTURE received");
    finishRecording()
      .then((response) => respondSafely(sendResponse, response))
      .catch((error) => {
        console.error("[GMR][OFFSCREEN] MediaRecorder stop failed", error);
        respondSafely(sendResponse, { ok: false, stage: "recorder-stop", message: String(error) });
      });
    return true;
  }
  if (message?.type !== "PREPARE_CAPTURE" || message?.target !== "offscreen") {
    return false;
  }
  if (typeof message.streamId !== "string" || message.streamId.length === 0) {
    console.error("[GMR][OFFSCREEN] invalid stream ID");
    respondSafely(sendResponse, {
      ok: false,
      stage: "offscreen-validation",
      message: "Invalid stream ID"
    });
    return false;
  }

  console.log("[GMR][OFFSCREEN] PREPARE_CAPTURE received");
  console.log("[GMR][OFFSCREEN] recording settings received:", {
    recordingMode: message.settings?.recordingMode,
    microphoneEnabled: message.settings?.microphoneEnabled,
    saveMode: message.settings?.saveMode
  });
  if (!mediaRecorder && !pendingRecording && !hasActiveTabStream() && !prepareCapturePending) {
    recordingTabId = message.tabId ?? null;
    recordingTabUrl = message.tabUrl || null;
  }
  console.log("[GMR][OFFSCREEN] stream ID received, length:", message.streamId.length);
  prepareCapture(message.streamId, message.settings)
    .then((response) => respondSafely(sendResponse, response))
    .catch((error) => {
      console.error("[GMR][OFFSCREEN] message handling failed", error);
      respondSafely(sendResponse, {
        ok: false,
        stage: "tab-media",
        message: error instanceof Error ? error.message : String(error)
      });
    });
  return true;
});

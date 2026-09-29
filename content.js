(() => {
  "use strict";

  console.log("[GMR][CONTENT] content script loaded");
  console.log("[GMR][CONTENT] URL:", window.location.href);

  let lastUrl = window.location.href;
  let previousMeetingState = false;
  let meetingUiVersion = 0;
  let meetingExitRequestPending = false;
  let observer = null;
  let meetingStatePollTimer = null;
  let debounceTimer = null;
  let buttonResetTimer = null;
  let startRequestPending = false;
  let waitingForExtensionInvocation = false;
  let invocationRetryUsed = false;
  let stopRequestPending = false;
  let captureState = "idle";
  let recordingStartedAt = null;
  let recordingTimerInterval = null;
  let recordingElapsedMs = 0;
  let recordButtonState = "idle";

  let isDraggingRecordButton = false;
  let dragMoved = false;
  let dragStartPointerX = 0;
  let dragStartPointerY = 0;
  let dragStartButtonX = 0;
  let dragStartButtonY = 0;
  let activePointerId = null;
  const DRAG_THRESHOLD = 5;
  let recordButtonPosition = null;

  function positionRecordButton(button, x, y) {
    // On unusually small viewports, prefer keeping the button on screen.
    const marginX = Math.min(12, Math.max(0, (window.innerWidth - button.offsetWidth) / 2));
    const marginY = Math.min(12, Math.max(0, (window.innerHeight - button.offsetHeight) / 2));
    const maxX = Math.max(marginX, window.innerWidth - button.offsetWidth - marginX);
    const maxY = Math.max(marginY, window.innerHeight - button.offsetHeight - marginY);
    recordButtonPosition = {
      x: Math.min(Math.max(marginX, x), maxX),
      y: Math.min(Math.max(marginY, y), maxY)
    };
    const styles = { left: `${recordButtonPosition.x}px`, top: `${recordButtonPosition.y}px`, right: "auto", bottom: "auto" };
    for (const [name, value] of Object.entries(styles)) {
      if (button.style[name] !== value) button.style[name] = value;
    }
  }

  function constrainRecordButtonPosition() {
    const button = document.getElementById("gmr-record-button");
    if (!button || !recordButtonPosition) return;
    positionRecordButton(button, recordButtonPosition.x, recordButtonPosition.y);
  }

  function finishRecordButtonDrag(button, cancelled = false) {
    if (!isDraggingRecordButton) return;
    const pointerId = activePointerId;
    isDraggingRecordButton = false;
    activePointerId = null;
    if (cancelled) dragMoved = false;
    button?.classList.remove("gmr-dragging");
    if (button?.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
    console.log("[GMR][CONTENT] record button drag ended");
  }

  function attachRecordButtonDrag(button) {
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false || button.disabled || isDraggingRecordButton) return;
      const rect = button.getBoundingClientRect();
      dragStartPointerX = event.clientX;
      dragStartPointerY = event.clientY;
      dragStartButtonX = rect.left;
      dragStartButtonY = rect.top;
      activePointerId = event.pointerId;
      dragMoved = false;
      isDraggingRecordButton = true;
      button.setPointerCapture(event.pointerId);
      button.classList.add("gmr-dragging");
      event.stopPropagation();
      console.log("[GMR][CONTENT] record button drag started");
    });
    button.addEventListener("pointermove", (event) => {
      if (!isDraggingRecordButton || event.pointerId !== activePointerId) return;
      const dx = event.clientX - dragStartPointerX;
      const dy = event.clientY - dragStartPointerY;
      if (!dragMoved && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      if (!dragMoved) {
        dragMoved = true;
        console.log("[GMR][CONTENT] record button moved");
      }
      event.preventDefault();
      event.stopPropagation();
      positionRecordButton(button, dragStartButtonX + dx, dragStartButtonY + dy);
    });
    button.addEventListener("pointerup", (event) => {
      if (event.pointerId !== activePointerId) return;
      if (dragMoved) event.preventDefault();
      event.stopPropagation();
      finishRecordButtonDrag(button);
    });
    button.addEventListener("pointercancel", (event) => {
      if (event.pointerId !== activePointerId) return;
      event.stopPropagation();
      finishRecordButtonDrag(button, true);
    });
    button.addEventListener("lostpointercapture", () => {
      // Normal pointerup has already cleared the active pointer.
      finishRecordButtonDrag(button, true);
    });
  }

  function formatRecordingDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const pad = (value) => String(value).padStart(2, "0");
    const minutesAndSeconds = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
    return seconds >= 3600 ? `${pad(Math.floor(seconds / 3600))}:${minutesAndSeconds}` : minutesAndSeconds;
  }

  function stopRecordingTimer() {
    if (recordingTimerInterval === null) return;
    recordingElapsedMs = recordingStartedAt === null ? 0 : Date.now() - recordingStartedAt;
    window.clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
    console.log("[GMR][CONTENT] recording timer stopped");
  }

  function startRecordingTimer() {
    stopRecordingTimer();
    recordingTimerInterval = window.setInterval(updateRecordingTimer, 250);
    updateRecordingTimer();
    console.log("[GMR][CONTENT] recording timer started");
  }

  function updateRecordingTimer() {
    const button = document.getElementById("gmr-record-button");
    if (!button) {
      stopRecordingTimer();
      return;
    }
    if (recordButtonState !== "capturing") return;
    const elapsed = recordingTimerInterval !== null && recordingStartedAt !== null
      ? Date.now() - recordingStartedAt : recordingElapsedMs;
    const formattedTime = formatRecordingDuration(elapsed);
    const timer = button.querySelector(".gmr-record-timer");
    if (timer.textContent !== formattedTime) {
      timer.textContent = formattedTime;
      constrainRecordButtonPosition();
    }
    const label = `Остановить запись. Длительность ${formattedTime}`;
    if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  }

  function renderRecordButtonState(state) {
    recordButtonState = state;
    const button = document.getElementById("gmr-record-button");
    if (!button) return;
    const labels = {
      idle: "Запись", starting: "Запуск...", capturing: "Стоп",
      stopping: "Остановка...", saving: "Сохранение...",
      saved: "Сохранено!", permission: "Разрешить запись"
    };
    const capturing = state === "capturing";
    const cat = button.querySelector(".gmr-record-cat");
    const catUrl = chrome.runtime.getURL(capturing ? "assets/cat-recording.png" : "assets/cat-idle.png");
    if (cat.src !== catUrl) cat.src = catUrl;
    button.querySelector(".gmr-record-label").textContent = labels[state];
    button.querySelector(".gmr-recording-dot").hidden = !capturing;
    button.querySelector(".gmr-record-timer").hidden = !capturing;
    button.disabled = ["starting", "stopping", "saving", "saved"].includes(state);
    button.classList.toggle("gmr-record-button--recording", capturing);
    if (capturing) updateRecordingTimer();
    else button.setAttribute("aria-label", state === "idle" ? "Начать запись"
      : state === "permission" ? "Нажмите на иконку расширения, чтобы включить запись" : labels[state]);
    constrainRecordButtonPosition();
  }

  function resetRecordingUi() {
    stopRecordingTimer();
    recordingStartedAt = null;
    recordingElapsedMs = 0;
    renderRecordButtonState("idle");
  }

  function isGoogleMeetPage() {
    return window.location.hostname === "meet.google.com";
  }

  function getVisibleControls() {
    return Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((element) => {
        if (element.id === "gmr-record-button" ||
            element.closest("[hidden], [aria-hidden='true']") ||
            element.getClientRects().length === 0) {
          return false;
        }
        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none";
      });
  }

  function elementContainsAnyLabel(element, candidates) {
    const label = ["aria-label", "data-tooltip", "title"]
      .map((attribute) => element.getAttribute(attribute) || "")
      .join(" ").toLowerCase().replace(/\s+/g, " ");
    return candidates.some((candidate) => label.includes(candidate));
  }

  function findMeetingControlSignals(controls = getVisibleControls()) {
    const candidates = {
      leaveCallFound: ["leave call", "leave the call", "leave meeting", "leave the meeting",
        "end call", "hang up", "покинуть вызов", "выйти из вызова", "завершить вызов",
        "завершить звонок", "покинуть звонок", "покинуть встречу", "выйти из встречи"],
      microphoneFound: ["microphone", "mute", "unmute", "микрофон"],
      cameraFound: ["camera", "turn on video", "turn off video", "камер", "включить видео",
        "выключить видео", "отключить видео"]
    };
    const signals = {
      microphoneFound: false,
      cameraFound: false,
      leaveCallFound: false,
      joinOrRejoinFound: false,
      meetingCodeFound: /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(
        window.location.pathname.replace(/^\/+|\/+$/g, "")
      ),
      activeCallUiFound: false
    };
    const usedControls = new Set();
    for (const [signal, labels] of Object.entries(candidates)) {
      const control = controls.find((element) =>
        !usedControls.has(element) && elementContainsAnyLabel(element, labels)
      );
      if (control) {
        usedControls.add(control);
        signals[signal] = true;
      }
    }
    const joinCandidates = [
      "join now", "ask to join", "rejoin", "return to home screen",
      "присоединиться", "попросить присоединиться", "вернуться", "снова присоединиться"
    ];
    signals.joinOrRejoinFound = controls.some((element) => {
      const text = (element.textContent || "").toLowerCase().replace(/\s+/g, " ");
      return elementContainsAnyLabel(element, joinCandidates) ||
        joinCandidates.some((candidate) => text.includes(candidate));
    });
    signals.activeCallUiFound = signals.leaveCallFound ||
      (signals.microphoneFound && signals.cameraFound);
    return signals;
  }

  function isInsideMeeting(signals = findMeetingControlSignals()) {
    const callControlsCount = [
      signals.microphoneFound, signals.cameraFound, signals.leaveCallFound
    ].filter(Boolean).length;
    return isGoogleMeetPage() && signals.meetingCodeFound && !signals.joinOrRejoinFound &&
      (signals.leaveCallFound || callControlsCount >= 2);
  }

  function requestStopCapture(button) {
    removePermissionHint();
    if (stopRequestPending) {
      console.warn("[GMR][CONTENT] stop request already pending");
      return;
    }
    const requestUiVersion = meetingUiVersion;
    stopRequestPending = true;
    window.clearTimeout(buttonResetTimer);
    buttonResetTimer = null;
    stopRecordingTimer();
    renderRecordButtonState("stopping");
    console.log("[GMR][CONTENT] sending STOP_RECORDING");
    let saved = false;

    const finish = () => {
      if (requestUiVersion !== meetingUiVersion) return;
      stopRequestPending = false;
      if (captureState === "idle") {
        resetRecordingUi();
        if (saved && document.getElementById("gmr-record-button")) {
          renderRecordButtonState("saved");
          buttonResetTimer = window.setTimeout(() => {
            buttonResetTimer = null;
            if (requestUiVersion === meetingUiVersion && isInsideMeeting()) renderRecordButtonState("idle");
          }, 1500);
        }
      } else {
        // Saving can fail after the recorder stopped. Keep Stop available for retry,
        // but do not restart a timer for a recording that may already be a Blob.
        renderRecordButtonState("capturing");
      }
    };
    try {
      chrome.runtime.sendMessage({ type: "STOP_RECORDING" }, (response) => {
        try {
          const lastError = chrome.runtime.lastError;
          if (requestUiVersion !== meetingUiVersion) return;
          if (lastError) {
            console.error("[GMR][CONTENT] sendMessage failed:", lastError.message);
            return;
          }
          if (response?.ok === true && ["capture-stopped", "recording-saved"].includes(response.stage) && response.state === "idle") {
            captureState = "idle";
            saved = response.stage === "recording-saved";
            if (saved) console.log("[GMR][CONTENT] recording saved");
            console.log("[GMR][CONTENT] capture stopped");
            console.log("[GMR][CONTENT] capture state: idle");
          } else {
            if (response?.state === "idle") captureState = "idle";
            console.error("[GMR][CONTENT] stop failed at stage:", response?.stage, response?.message);
          }
        } catch (error) {
          console.error("[GMR][CONTENT] sendMessage failed:", error);
        } finally {
          finish();
        }
      });
      if (stopRequestPending && requestUiVersion === meetingUiVersion) renderRecordButtonState("saving");
    } catch (error) {
      console.error("[GMR][CONTENT] sendMessage failed:", error);
      finish();
    }
  }

  function showPermissionHint() {
    if (!document.body || document.getElementById("gmr-permission-hint")) return;
    const hint = document.createElement("div");
    hint.id = "gmr-permission-hint";
    hint.setAttribute("role", "status");
    hint.textContent = "Нажмите на иконку расширения, чтобы включить запись";
    document.body.appendChild(hint);
  }

  function removePermissionHint() {
    document.getElementById("gmr-permission-hint")?.remove();
  }

  function requestStartRecording(button) {
    if (startRequestPending) {
      console.warn("[GMR][CONTENT] start request already pending");
      return;
    }
    window.clearTimeout(buttonResetTimer);
    buttonResetTimer = null;
    resetRecordingUi();
    renderRecordButtonState("starting");
    console.log("[GMR][CONTENT] sending START_RECORDING");
    const requestUiVersion = meetingUiVersion;
    try {
      startRequestPending = true;
      chrome.runtime.sendMessage({ type: "START_RECORDING" }, (response) => {
        try {
          const lastError = chrome.runtime.lastError;
          if (requestUiVersion !== meetingUiVersion) return;
          startRequestPending = false;
          if (lastError) {
            console.error("[GMR][CONTENT] sendMessage failed:", lastError.message);
            return;
          }
          if (!response) {
            console.warn("[GMR][CONTENT] service worker returned no response");
            return;
          }
          console.log("[GMR][CONTENT] service worker response:", response);
          const needsInvocation = response.ok === false && response.stage === "tab-capture" &&
            typeof response.message === "string" &&
            response.message.includes("Extension has not been invoked");
          if (needsInvocation && !invocationRetryUsed) {
            // Ignore replies for a meeting whose controls have already disappeared.
            if (!isInsideMeeting() || document.getElementById("gmr-record-button") !== button) return;
            waitingForExtensionInvocation = true;
            invocationRetryUsed = false;
            console.log("[GMR][CONTENT] tab capture needs extension invocation");
            renderRecordButtonState("permission");
            showPermissionHint();
            return;
          }
          waitingForExtensionInvocation = false;
          removePermissionHint();
          if (response.ok === true) invocationRetryUsed = false;
          if (response.ok === false) {
            console.error("[GMR][CONTENT] recording start failed at stage:",
              response?.stage, response?.message);
          }
          if (response?.ok === true && response?.stage === "tab-capture") {
            console.log("[GMR][CONTENT] tab capture stream ID ready");
          }
          if (response?.ok === true && response?.stage === "offscreen-ready") {
            console.log("[GMR][CONTENT] offscreen document ready");
          }
          if (response?.ok === true && response?.stage === "tab-media-ready") {
            console.log("[GMR][CONTENT] tab audio MediaStream ready");
          }
          if (response?.ok === true && response?.stage === "sources-ready") {
            console.log("[GMR][CONTENT] tab and microphone sources ready");
          }
          // Also reconcile an already-active response after a worker restart.
          if (response?.ok === true && response?.stage === "recording") {
            console.log("[GMR][CONTENT] recording started");
          }
          if (response?.ok === true && response?.stage === "audio-mix-ready") {
            console.log("[GMR][CONTENT] tab and microphone audio mix ready");
          }
          if (response?.ok === true && response.stage === "recording" && response.state === "capturing") {
            captureState = "capturing";
            recordingStartedAt = Date.now();
            recordingElapsedMs = 0;
            renderRecordButtonState("capturing");
            startRecordingTimer();
            console.log("[GMR][CONTENT] capture state: capturing");
            if (!isInsideMeeting()) handleMeetingEnd();
          }
          if (response?.ok !== true && response?.stage === "capture-state" && response.state === "capturing") {
            console.warn("[GMR][CONTENT] service worker reports active capture");
          }
          // A reply can arrive after the meeting and its button are gone.
          if (document.getElementById("gmr-record-button") !== button) return;
          if (captureState !== "capturing") resetRecordingUi();
        } catch (error) {
          console.error("[GMR][CONTENT] sendMessage failed:", error);
        } finally {
          if (requestUiVersion === meetingUiVersion && !waitingForExtensionInvocation && captureState !== "capturing") {
            resetRecordingUi();
          }
        }
      });
    } catch (error) {
      startRequestPending = false;
      resetRecordingUi();
      console.error("[GMR][CONTENT] sendMessage failed:", error);
    }
  }

  function createRecordButton() {
    if (document.getElementById("gmr-record-button")) return;
    if (!document.body) {
      console.warn("[GMR][CONTENT] document.body unavailable; record button creation skipped");
      return;
    }

    const button = document.createElement("button");
    button.id = "gmr-record-button";
    button.className = "gmr-record-button";
    const cat = document.createElement("img");
    cat.className = "gmr-record-cat";
    cat.alt = "";
    cat.draggable = false;
    button.appendChild(cat);
    for (const className of ["gmr-recording-dot", "gmr-record-label", "gmr-record-timer"]) {
      const span = document.createElement("span");
      span.className = className;
      if (className !== "gmr-record-label") span.setAttribute("aria-hidden", "true");
      button.appendChild(span);
    }
    button.type = "button";
    attachRecordButtonDrag(button);
    button.addEventListener("click", (event) => {
      // Keyboard activation has detail=0 and must not inherit a prior drag.
      if (dragMoved && event.detail !== 0) {
        dragMoved = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      dragMoved = false;
      console.log("[GMR][CONTENT] record button clicked");
      if (captureState === "capturing") {
        requestStopCapture(button);
        return;
      }
      if (waitingForExtensionInvocation) return;
      // Each explicit user start gets at most one automatic invocation retry.
      if (!startRequestPending) invocationRetryUsed = false;
      requestStartRecording(button);
    });
    document.body.appendChild(button);
    renderRecordButtonState(recordButtonState);
    console.log("[GMR][CONTENT] record button created");
  }

  function removeRecordButton() {
    finishRecordButtonDrag(document.getElementById("gmr-record-button"), true);
    dragMoved = false;
    stopRecordingTimer();
    recordingStartedAt = null;
    recordingElapsedMs = 0;
    recordButtonState = "idle";
    removePermissionHint();
    const button = document.getElementById("gmr-record-button");
    if (!button) return;
    window.clearTimeout(buttonResetTimer);
    buttonResetTimer = null;
    button.remove();
    console.log("[GMR][CONTENT] record button removed");
  }

  function handleMeetingEnd() {
    stopRecordingTimer();
    recordingStartedAt = null;
    recordingElapsedMs = 0;
    waitingForExtensionInvocation = false;
    invocationRetryUsed = false;
    removePermissionHint();
    window.clearTimeout(buttonResetTimer);
    buttonResetTimer = null;
    if (captureState === "idle") {
      removeRecordButton();
      console.log("[GMR][CONTENT] record button removed after meeting end");
      return;
    }
    const button = document.getElementById("gmr-record-button");
    if (button) {
      renderRecordButtonState("saving");
    }
    if (meetingExitRequestPending) return;
    console.log("[GMR][CONTENT] meeting ended while recording");
    meetingExitRequestPending = true;
    const requestUiVersion = meetingUiVersion;
    const finish = () => {
      // A reply from the previous meeting must not remove a new meeting's UI.
      if (requestUiVersion !== meetingUiVersion) return;
      captureState = "idle";
      startRequestPending = false;
      stopRequestPending = false;
      meetingExitRequestPending = false;
      removeRecordButton();
    };
    console.log("[GMR][CONTENT] sending MEETING_LEFT after meeting end");
    try {
      chrome.runtime.sendMessage({ type: "MEETING_LEFT" }, (response) => {
        try {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            console.error("[GMR][CONTENT] MEETING_LEFT runtime error:", lastError.message);
            return;
          }
          if (response?.ok === true && response.stage === "recording-saved") {
            console.log("[GMR][CONTENT] recording saved after meeting end");
          } else {
            console.error("[GMR][CONTENT] MEETING_LEFT failed:", response?.message);
          }
        } catch (error) {
          console.error("[GMR][CONTENT] MEETING_LEFT failed:", error);
        } finally {
          finish();
        }
      });
    } catch (error) {
      console.error("[GMR][CONTENT] MEETING_LEFT runtime error:", error);
      finish();
    }
  }

  function updateExtensionUi() {
    try {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        console.log("[GMR][CONTENT] URL changed:", currentUrl);
        lastUrl = currentUrl;
      }

      const signals = findMeetingControlSignals();
      const insideMeeting = isInsideMeeting(signals);
      if (insideMeeting !== previousMeetingState) {
        console.log(insideMeeting
          ? "[GMR][CONTENT] meeting detected"
          : "[GMR][CONTENT] meeting no longer detected", {
            microphoneFound: signals.microphoneFound,
            cameraFound: signals.cameraFound,
            leaveCallFound: signals.leaveCallFound
          });
        const meetingEnded = previousMeetingState && !insideMeeting;
        previousMeetingState = insideMeeting;
        meetingUiVersion += 1;
        if (meetingEnded) {
          console.log("[GMR][CONTENT] active meeting ended");
          handleMeetingEnd();
        } else if (insideMeeting) {
          console.log("[GMR][CONTENT] active meeting detected");
          meetingExitRequestPending = false;
          if (!document.getElementById("gmr-record-button")) {
            createRecordButton();
          }
        }
      }

      if (insideMeeting) createRecordButton();
      else if (!meetingExitRequestPending) removeRecordButton();
    } catch (error) {
      console.error("[GMR][CONTENT] updateExtensionUi failed", error);
    }
  }

  function initialize() {
    try {
      if (!isGoogleMeetPage()) return;
      if (!document.body) {
        window.setTimeout(initialize, 50);
        return;
      }
      if (observer) return;

      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== "EXTENSION_INVOKED") return false;
        try {
          console.log("[GMR][CONTENT] extension invocation received");
          const button = document.getElementById("gmr-record-button");
          if (waitingForExtensionInvocation) {
            waitingForExtensionInvocation = false;
            removePermissionHint();
            if (button && isInsideMeeting() && !invocationRetryUsed) {
              invocationRetryUsed = true;
              console.log("[GMR][CONTENT] invocation received, retrying pending START");
              requestStartRecording(button);
            }
          }

          sendResponse({ ok: true });
        } catch (error) {
          console.error("[GMR][CONTENT] extension invocation handling failed:", error);
        }
        return false;
      });

      observer = new MutationObserver(() => {
        window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(updateExtensionUi, 300);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: [
          "aria-label",
          "aria-hidden",
          "data-tooltip",
          "title",
          "hidden",
          "style"
        ]
      });
      console.log("[GMR][CONTENT] MutationObserver started");
      if (meetingStatePollTimer === null) {
        meetingStatePollTimer = window.setInterval(updateExtensionUi, 1000);
      }
      updateExtensionUi();
    } catch (error) {
      console.error("[GMR][CONTENT] initialization failed", error);
    }
  }

  window.addEventListener("resize", constrainRecordButtonPosition);

  window.addEventListener("pagehide", () => {
    finishRecordButtonDrag(document.getElementById("gmr-record-button"), true);
    dragMoved = false;
    stopRecordingTimer();
    recordingStartedAt = null;
    window.clearTimeout(buttonResetTimer);
  });

  initialize();
})();

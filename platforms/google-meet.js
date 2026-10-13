(() => {
  "use strict";

  function matchesLocation() {
    return window.location.hostname === "meet.google.com";
  }

  function getMeetingId() {
    const code = window.location.pathname.replace(/^\/+|\/+$/g, "");
    return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(code) ? code : null;
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

  function getMeetingState(controls = getVisibleControls()) {
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
      meetingCodeFound: getMeetingId() !== null,
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

  function isInsideMeeting(signals = getMeetingState()) {
    const callControlsCount = [
      signals.microphoneFound, signals.cameraFound, signals.leaveCallFound
    ].filter(Boolean).length;
    return matchesLocation() && signals.meetingCodeFound && !signals.joinOrRejoinFound &&
      (signals.leaveCallFound || callControlsCount >= 2);
  }

  // Preserve the existing inside -> outside transition; callers own lifecycle state.
  function isMeetingEnded(wasInsideMeeting, state = getMeetingState()) {
    return wasInsideMeeting && !isInsideMeeting(state);
  }

  window.GMRPlatforms = window.GMRPlatforms || {};
  window.GMRPlatforms.googleMeet = {
    id: "meet",
    matchesLocation,
    getMeetingId,
    getMeetingState,
    isInsideMeeting,
    isMeetingEnded
  };
})();

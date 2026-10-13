(() => {
  "use strict";

  function matchesLocation() {
    return window.location.hostname === "teams.live.com";
  }

  function getMeetingId() {
    return window.location.pathname.match(/^\/meet\/(\d+)\/?$/)?.[1] || "meeting";
  }

  function isVisible(element) {
    if (element.closest("[hidden], [aria-hidden='true']") || !element.getClientRects().length) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function hasVisible(selector) {
    return Array.from(document.querySelectorAll(selector)).some(isVisible);
  }

  function getMeetingState() {
    // IDs/data-tid below were observed in the real teams.live.com meeting UI.
    const state = {
      microphoneFound: hasVisible("#microphone-button"),
      cameraFound: hasVisible("#video-button"),
      leaveCallFound: hasVisible('[data-tid="hangup-main-btn"], #hangup-button'),
      joinOrRejoinFound: hasVisible('[data-tid="prejoin-join-button"], #prejoin-join-button'),
      meetingToolbarFound: hasVisible('[data-tid="ubar-horizontal-middle-end"], #horizontalMiddleEnd'),
      meetingIdFound: getMeetingId() !== "meeting",
      activeCallUiFound: false,
      insideMeeting: false
    };
    // Localized join/rejoin buttons also exclude post-call and prejoin screens.
    if (!state.joinOrRejoinFound) {
      const joinLabel = /^(join(?: now)?|rejoin|join again|присоединиться(?: сейчас)?|повторно присоединиться|присоединиться снова|вернуться)$/i;
      state.joinOrRejoinFound = Array.from(document.querySelectorAll("button, [role='button']"))
        .some((element) => isVisible(element) &&
          [element.getAttribute("aria-label"), element.textContent].some((text) =>
            joinLabel.test((text || "").replace(/\s+/g, " ").trim())));
    }
    state.activeCallUiFound = state.leaveCallFound ||
      (state.meetingToolbarFound && state.microphoneFound && state.cameraFound);
    state.insideMeeting = isInsideMeeting(state);
    return state;
  }

  function isInsideMeeting(state = getMeetingState()) {
    return matchesLocation() && state.activeCallUiFound && !state.joinOrRejoinFound;
  }

  function isMeetingEnded(wasInsideMeeting, state = getMeetingState()) {
    return wasInsideMeeting && !isInsideMeeting(state);
  }

  window.GMRPlatforms = window.GMRPlatforms || {};
  window.GMRPlatforms.teams = {
    id: "teams", matchesLocation, getMeetingId, getMeetingState, isInsideMeeting, isMeetingEnded
  };
})();

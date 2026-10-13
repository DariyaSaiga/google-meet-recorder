(() => {
  "use strict";

  function matchesLocation() {
    return window.location.hostname === "app.zoom.us";
  }

  function getMeetingId() {
    return window.location.pathname.match(/^\/wc\/(\d+)\/(?:join|start)\/?$/)?.[1] || "meeting";
  }

  function hasVisible(selector) {
    return Array.from(document.querySelectorAll(selector)).some((element) => {
      if (element.closest('[hidden], [aria-hidden="true"]') || !element.getClientRects().length) return false;
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    });
  }

  function getMeetingState() {
    // Markers confirmed in the real app.zoom.us meeting iframe.
    // Join Audio is an audio control, not a meeting join/prejoin signal.
    const state = {
      microphoneFound: hasVisible(".join-audio-container__btn"),
      cameraFound: hasVisible(".send-video-container__btn"),
      leaveCallFound: hasVisible('.footer__leave-btn-container, button[aria-label="End"]'),
      meetingToolbarFound: hasVisible("footer#wc-footer, #foot-bar"),
      meetingIdFound: getMeetingId() !== "meeting",
      meetingPathFound: /^\/wc\/\d+\/(?:join|start)\/?$/.test(window.location.pathname),
      homePathFound: /^\/wc\/home\/?$/.test(window.location.pathname),
      activeCallUiFound: false,
      insideMeeting: false
    };
    state.activeCallUiFound = state.leaveCallFound ||
      (state.meetingToolbarFound && state.microphoneFound && state.cameraFound);
    state.insideMeeting = isInsideMeeting(state);
    return state;
  }

  function isInsideMeeting(state = getMeetingState()) {
    return matchesLocation() && state.meetingPathFound && !state.homePathFound && state.activeCallUiFound;
  }

  function isMeetingEnded(wasInsideMeeting, state = getMeetingState()) {
    return wasInsideMeeting && !isInsideMeeting(state);
  }

  window.GMRPlatforms = window.GMRPlatforms || {};
  window.GMRPlatforms.zoom = {
    id: "zoom", matchesLocation, getMeetingId, getMeetingState, isInsideMeeting, isMeetingEnded
  };
})();

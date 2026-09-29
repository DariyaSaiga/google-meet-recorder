"use strict";

console.log("[GMR][MIC-PERMISSION] permission page loaded");

const allowButton = document.getElementById("allow-microphone");
const permissionStatus = document.getElementById("permission-status");
let requestPending = false;
let userRequestStarted = false;

function closePermissionPage(delay) {
  window.setTimeout(() => {
    try {
      window.close();
    } catch (error) {
      console.warn("[GMR][MIC-PERMISSION] could not close permission page", error);
    }
  }, delay);
}

allowButton.addEventListener("click", async () => {
  if (requestPending || allowButton.disabled) return;
  requestPending = true;
  userRequestStarted = true;
  allowButton.disabled = true;
  console.log("[GMR][MIC-PERMISSION] requesting microphone access");
  permissionStatus.textContent = "Ожидаем разрешение Chrome на доступ к микрофону...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });
    try {
      console.log("[GMR][MIC-PERMISSION] microphone permission granted");
      const audioTracks = stream.getAudioTracks();
      console.log("[GMR][MIC-PERMISSION] microphone audio tracks:", audioTracks.length);
      if (audioTracks.length === 0) throw new Error("Microphone stream contains no audio tracks");
      const track = audioTracks[0];
      console.log("[GMR][MIC-PERMISSION] microphone track state:", {
        kind: track.kind,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState
      });
    } finally {
      stream.getTracks().forEach((track) => track.stop());
      console.log("[GMR][MIC-PERMISSION] microphone test stream stopped");
    }
    permissionStatus.textContent = "Доступ разрешён. Можно вернуться в Google Meet.";
    allowButton.textContent = "♡ Доступ разрешён";
    closePermissionPage(1200);
  } catch (error) {
    console.error("[GMR][MIC-PERMISSION] microphone request failed:", error);
    console.error("[GMR][MIC-PERMISSION] error details:", {
      name: error?.name,
      message: error?.message
    });
    permissionStatus.textContent = "Не удалось получить доступ к микрофону";
    allowButton.disabled = false;
  } finally {
    requestPending = false;
  }
});

async function checkCurrentPermission() {
  try {
    const result = await navigator.permissions.query({ name: "microphone" });
    console.log("[GMR][MIC-PERMISSION] current permission state:", result.state);
    // Do not overwrite a request started before this initial query completed.
    if (userRequestStarted) return;
    if (result.state === "granted") {
      permissionStatus.textContent = "Доступ к микрофону уже разрешён";
      allowButton.textContent = "♡ Микрофон готов";
      allowButton.disabled = true;
      closePermissionPage(1000);
    } else if (result.state === "denied") {
      permissionStatus.textContent = "Доступ к микрофону заблокирован. Разрешите его в настройках Chrome.";
    }
  } catch (error) {
    console.warn("[GMR][MIC-PERMISSION] permission query unavailable", error);
  }
}

checkCurrentPermission();

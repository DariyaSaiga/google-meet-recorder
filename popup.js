"use strict";

console.log("[GMR][POPUP] settings page loaded");

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

let saveQueue = Promise.resolve();
let statusTimer = null;
const settingsForm = document.getElementById("settings-form");
const settingsControls = document.getElementById("settings-controls");
const settingsStatus = document.getElementById("settings-status");
const microphoneToggle = document.getElementById("microphone-enabled");

const chooseFolderButton = document.getElementById("choose-folder");
const folderStatus = document.getElementById("folder-status");
const restoreFolderButton = document.getElementById("restore-folder-access");
let selectedDirectoryHandle = null;

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

async function directoryHandleTransaction(mode, operation) {
  const db = await openFolderDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", mode);
      const request = operation(tx.objectStore("handles"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || new Error("Directory handle transaction aborted"));
      tx.onerror = () => reject(tx.error || request.error);
    });
  } finally {
    db.close();
  }
}

async function saveDirectoryHandle(handle) {
  await directoryHandleTransaction("readwrite", (store) => store.put(handle, "selectedDirectory"));
  console.log("[GMR][POPUP] directory handle saved to IndexedDB");
}

async function getDirectoryHandle() {
  return directoryHandleTransaction("readonly", (store) => store.get("selectedDirectory"));
}

async function clearDirectoryHandle() {
  await directoryHandleTransaction("readwrite", (store) => store.delete("selectedDirectory"));
  selectedDirectoryHandle = null;
}

async function verifyDirectoryPermission(handle, request = false) {
  const options = { mode: "readwrite" };
  if (request) {
    // Called directly from the restore button, before any asynchronous work.
    return (await handle.requestPermission(options)) === "granted";
  }
  return (await handle.queryPermission(options)) === "granted";
}

async function refreshFolderStatus() {
  selectedDirectoryHandle = await getDirectoryHandle();
  restoreFolderButton.hidden = true;
  if (!selectedDirectoryHandle) {
    folderStatus.textContent = "Папка ещё не выбрана";
    return;
  }
  if (await verifyDirectoryPermission(selectedDirectoryHandle)) {
    folderStatus.textContent = `Выбрана папка: ${selectedDirectoryHandle.name}`;
  } else {
    folderStatus.textContent = "Нужно снова разрешить доступ к выбранной папке";
    restoreFolderButton.hidden = false;
  }
}

chooseFolderButton.addEventListener("click", async () => {
  chooseFolderButton.disabled = true;
  settingsControls.disabled = true;
  try {
    console.log("[GMR][POPUP] folder picker opened");
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    console.log("[GMR][POPUP] folder selected:", handle.name);
    await saveDirectoryHandle(handle);
    const settings = await saveSettings({ saveMode: "selected-folder" });
    renderSettings(settings);
    await refreshFolderStatus();
  } catch (error) {
    if (error?.name === "AbortError") {
      folderStatus.textContent = "Выбор папки отменён";
    } else {
      console.error("[GMR][POPUP] folder selection failed:", error?.name);
      folderStatus.textContent = "Не удалось выбрать папку. Попробуйте ещё раз.";
    }
  } finally {
    chooseFolderButton.disabled = false;
    settingsControls.disabled = false;
  }
});

restoreFolderButton.addEventListener("click", async () => {
  if (!selectedDirectoryHandle) return;
  restoreFolderButton.disabled = true;
  try {
    const granted = await verifyDirectoryPermission(selectedDirectoryHandle, true);
    folderStatus.textContent = granted
      ? `Выбрана папка: ${selectedDirectoryHandle.name}`
      : "Нужно снова разрешить доступ к выбранной папке";
    restoreFolderButton.hidden = granted;
  } catch (error) {
    console.error("[GMR][POPUP] directory permission failed:", error?.name);
    folderStatus.textContent = "Не удалось разрешить доступ к папке";
  } finally {
    restoreFolderButton.disabled = false;
  }
});

async function loadSettings() {
  const result = await chrome.storage.local.get("gmrSettings");
  let stored = result.gmrSettings;
  if (stored == null) {
    const legacyKeys = ["recordingMode", "microphoneEnabled", "saveMode", "settings"];
    const legacy = await chrome.storage.local.get(legacyKeys);
    const nested = legacy.settings || {};
    if (Object.keys(DEFAULT_SETTINGS).some((key) =>
      Object.hasOwn(legacy, key) || Object.hasOwn(nested, key))) {
      stored = normalizeSettings({
        recordingMode: legacy.recordingMode ?? nested.recordingMode ?? DEFAULT_SETTINGS.recordingMode,
        microphoneEnabled: legacy.microphoneEnabled ?? nested.microphoneEnabled ?? DEFAULT_SETTINGS.microphoneEnabled,
        saveMode: legacy.saveMode ?? nested.saveMode ?? DEFAULT_SETTINGS.saveMode
      });
      await chrome.storage.local.set({ gmrSettings: stored });
      await chrome.storage.local.remove(legacyKeys);
      console.log("[GMR][POPUP] legacy settings migrated");
    }
  }
  stored = stored || {};
  const settings = normalizeSettings({
    recordingMode: stored.recordingMode ?? DEFAULT_SETTINGS.recordingMode,
    microphoneEnabled: stored.microphoneEnabled ?? DEFAULT_SETTINGS.microphoneEnabled,
    saveMode: stored.saveMode ?? DEFAULT_SETTINGS.saveMode
  });
  console.log("[GMR][POPUP] settings loaded:", settings);
  return settings;
}

async function saveSettings(partial) {
  // Serialize read/merge/write operations so rapid edits preserve other fields.
  const patch = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.hasOwn(partial, key)) patch[key] = partial[key];
  }
  const operation = saveQueue.then(async () => {
    const current = await loadSettings();
    const next = normalizeSettings({ ...current, ...patch });
    await chrome.storage.local.set({ gmrSettings: next });
    console.log("[GMR][POPUP] settings saved:", next);
    const verify = await chrome.storage.local.get("gmrSettings");
    console.log("[GMR][POPUP] storage verification:", verify.gmrSettings);
    return next;
  });
  saveQueue = operation.catch(() => {});
  return operation;
}

function renderSettings(settings) {
  for (const input of settingsForm.querySelectorAll("input")) {
    input.checked = input.type === "checkbox"
      ? settings.microphoneEnabled : input.value === settings[input.name];
  }
}

settingsForm.addEventListener("submit", (event) => event.preventDefault());
settingsForm.addEventListener("change", async (event) => {
  const input = event.target;
  if (!Object.hasOwn(DEFAULT_SETTINGS, input.name) || input.disabled) return;
  const value = input.type === "checkbox" ? input.checked : input.value;
  if (input === microphoneToggle) {
    console.log("[GMR][POPUP] microphone setting changed:", microphoneToggle.checked);
  }
  window.clearTimeout(statusTimer);
  settingsStatus.textContent = "Сохранение настроек...";
  settingsControls.disabled = true;
  try {
    if (input.name === "saveMode" && value === "selected-folder") {
      const handle = await getDirectoryHandle();
      if (!handle) {
        renderSettings(await loadSettings());
        folderStatus.textContent = "Сначала выберите папку";
        settingsStatus.textContent = "";
        return;
      }
    }
    await saveSettings({ [input.name]: value });
    if (input.name === "saveMode") await refreshFolderStatus();
    console.log(`[GMR][POPUP] setting changed: ${input.name} -> ${value}`);
    window.clearTimeout(statusTimer);
    settingsStatus.textContent = "Настройки сохранены";
    statusTimer = window.setTimeout(() => { settingsStatus.textContent = ""; }, 1500);
  } catch (error) {
    console.error("[GMR][POPUP] settings save failed:", error);
    window.clearTimeout(statusTimer);
    settingsStatus.textContent = "Не удалось сохранить настройки. Измените настройку ещё раз, чтобы повторить.";
  } finally {
    settingsControls.disabled = false;
  }
});

async function initializeSettings() {
  try {
    const settings = await loadSettings();
    renderSettings(settings);
    settingsStatus.textContent = "";
    settingsControls.disabled = false;
    try {
      await refreshFolderStatus();
    } catch (error) {
      console.error("[GMR][POPUP] directory handle load failed:", error?.name);
      folderStatus.textContent = "Не удалось загрузить выбранную папку. Выберите папку снова.";
    }
  } catch (error) {
    console.error("[GMR][POPUP] settings load failed:", error);
    settingsStatus.textContent = "Не удалось загрузить настройки. Откройте страницу ещё раз.";
  }
}

initializeSettings();

const enableButton = document.getElementById("enable-microphone");
const microphoneStatus = document.getElementById("microphone-status");
let requestPending = false;
let userRequestStarted = false;

enableButton.addEventListener("click", async () => {
  if (requestPending) return;
  console.log("[GMR][POPUP] enable microphone clicked");
  requestPending = true;
  userRequestStarted = true;
  enableButton.disabled = true;
  microphoneStatus.textContent = "Открываем страницу доступа к микрофону...";

  try {
    console.log("[GMR][POPUP] opening microphone permission page");
    const url = chrome.runtime.getURL("request-mic.html");
    await chrome.tabs.create({ url });
    console.log("[GMR][POPUP] microphone permission page opened");
    microphoneStatus.textContent = "Продолжите на вкладке доступа к микрофону.";
  } catch (error) {
    console.error("[GMR][POPUP] microphone permission page failed to open:", error);
    microphoneStatus.textContent = "Не удалось открыть страницу доступа к микрофону";
  } finally {
    requestPending = false;
    enableButton.disabled = false;
  }
});

async function checkMicrophonePermission() {
  try {
    const permission = await navigator.permissions.query({ name: "microphone" });
    console.log("[GMR][POPUP] microphone permission state:", permission.state);
    // A delayed initial query must not overwrite the user's request result.
    if (userRequestStarted) return;
    if (permission.state === "granted") {
      microphoneStatus.textContent = "Доступ к микрофону разрешён";
      enableButton.textContent = "♡ Микрофон готов";
    } else if (permission.state === "prompt") {
      microphoneStatus.textContent = "Требуется разрешение на использование микрофона";
    } else if (permission.state === "denied") {
      microphoneStatus.textContent = "Доступ к микрофону заблокирован";
    }
  } catch {
    console.warn("[GMR][POPUP] microphone permission query unavailable");
  }
}

checkMicrophonePermission();

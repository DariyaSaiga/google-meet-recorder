"use strict";

console.log("[GMR][POPUP] settings page loaded");

async function notifyExtensionInvocation() {
  console.log("[GMR][POPUP] extension popup opened");
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    console.warn("[GMR][POPUP] active tab unavailable");
    return;
  }
  const platform = tab?.url?.startsWith("https://meet.google.com/") ? "meet"
    : tab?.url?.startsWith("https://teams.live.com/") ? "teams"
    : /^https:\/\/app\.zoom\.us\/wc(?:\/|[?#]|$)/.test(tab?.url || "") ? "zoom" : null;
  if (!Number.isInteger(tab?.id) || tab.id < 0 || !platform) {
    console.log("[GMR][POPUP] active tab is not a supported meeting page");
    return;
  }
  console.log("[GMR][POPUP] supported meeting tab invoked", { platform });
  console.log("[GMR][POPUP] notifying content about extension invocation");
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "EXTENSION_INVOKED" });
    console.log("[GMR][POPUP] content notified about extension invocation");
  } catch {
    console.warn("[GMR][POPUP] content script not available on active tab");
  }
}

// Keep the invocation handoff independent of settings initialization.
notifyExtensionInvocation();

const DEFAULT_SETTINGS = {
  recordingMode: "audio",
  microphoneEnabled: true,
  saveMode: "downloads",
  transcriptionEnabled: false
};

function normalizeSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  return {
    recordingMode: ["audio", "audio-video"].includes(settings.recordingMode)
      ? settings.recordingMode : DEFAULT_SETTINGS.recordingMode,
    microphoneEnabled: typeof settings.microphoneEnabled === "boolean"
      ? settings.microphoneEnabled : DEFAULT_SETTINGS.microphoneEnabled,
    saveMode: ["downloads", "ask", "selected-folder"].includes(settings.saveMode)
      ? settings.saveMode : DEFAULT_SETTINGS.saveMode,
    transcriptionEnabled: settings.transcriptionEnabled === true
  };
}

let saveQueue = Promise.resolve();
let statusTimer = null;
let currentSettings = { ...DEFAULT_SETTINGS };
let shainoteAccount = null;
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
    saveMode: stored.saveMode ?? DEFAULT_SETTINGS.saveMode,
    transcriptionEnabled: stored.transcriptionEnabled ?? DEFAULT_SETTINGS.transcriptionEnabled
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
      ? settings[input.name] === true : input.value === settings[input.name];
  }
  currentSettings = settings;
  renderTranscriptionSetting();
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
    renderSettings(await saveSettings({ [input.name]: value }));
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
      enableButton.textContent = "Микрофон готов";
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

// ShaiNote: account, Transcription setting and the Transcriptions list.
const signinForm = document.getElementById("signin-form");
const signinEmail = document.getElementById("signin-email");
const signinPassword = document.getElementById("signin-password");
const signinButton = document.getElementById("signin-button");
const signinStatus = document.getElementById("signin-status");
const accountView = document.getElementById("account");
const accountEmail = document.getElementById("account-email");
const signoutButton = document.getElementById("signout-button");
const transcriptionToggle = document.getElementById("transcription-enabled");
const transcriptionHint = document.getElementById("transcription-hint");
const transcriptionsCard = document.getElementById("transcriptions-card");
const transcriptionsList = document.getElementById("transcriptions-list");

const SERVER_STAGES = {
  created: "В очереди ShaiNote",
  queued: "В очереди ShaiNote",
  processing: "ShaiNote обрабатывает запись",
  uploading: "ShaiNote загружает аудио",
  converting: "ShaiNote конвертирует аудио",
  transcribing: "ShaiNote расшифровывает запись",
  merging: "ShaiNote собирает расшифровку",
  summarizing: "ShaiNote готовит резюме"
};

function renderTranscriptionSetting() {
  const signedIn = Boolean(shainoteAccount);
  signinForm.hidden = signedIn;
  accountView.hidden = !signedIn;
  accountEmail.textContent = signedIn ? `Вы вошли как ${shainoteAccount.email}` : "";
  transcriptionToggle.disabled = !signedIn;
  transcriptionToggle.checked = signedIn && currentSettings.transcriptionEnabled;
  transcriptionHint.classList.remove("warning");
  if (!signedIn) {
    transcriptionHint.textContent = "Чтобы включить расшифровку, войдите в ShaiNote.";
  } else if (!currentSettings.transcriptionEnabled) {
    transcriptionHint.textContent = "Записи остаются только на этом компьютере.";
  } else if (!currentSettings.microphoneEnabled) {
    transcriptionHint.classList.add("warning");
    transcriptionHint.textContent = "Микрофон выключен: вашего голоса не будет в расшифровке. Включите микрофон выше.";
  } else {
    transcriptionHint.textContent = "Со следующей записи аудио отправится в ShaiNote, а расшифровка и резюме сохранятся рядом с записью.";
  }
}

function describeTranscription(record) {
  switch (record.state) {
    case "too-short": return { text: "Запись короче 30 секунд — не отправлялась" };
    case "uploading": return { text: "Отправка аудио в ShaiNote…" };
    case "upload-failed": return { text: record.error, error: true };
    case "failed": return { text: `ShaiNote не смог обработать запись: ${record.error}`, error: true };
    case "processing":
      return record.error ? { text: record.error, error: true }
        : { text: `${SERVER_STAGES[record.serverStatus] || "В очереди ShaiNote"}…` };
  }
  const transcript = { saved: "Расшифровка сохранена", pending: "Сохраняем расшифровку…", failed: "Расшифровка недоступна" }[record.transcript];
  const summary = { saved: "резюме сохранено", pending: "готовим резюме…", waiting: "готовим резюме…", failed: "резюме недоступно" }[record.summary];
  return { text: `${transcript}, ${summary}`, error: record.transcript === "failed" };
}

function isFinished(record) {
  if (record.state === "uploading" || record.state === "processing") return false;
  return record.state !== "completed" ||
    (record.transcript !== "pending" && !["pending", "waiting"].includes(record.summary));
}

function sendTranscriptionMessage(message) {
  return chrome.runtime.sendMessage(message).catch((error) => {
    console.error("[GMR][POPUP] transcription message failed:", error);
    return { ok: false, error: "Расширение недоступно, откройте страницу ещё раз" };
  });
}

function actionButton(label, onClick, secondary) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (secondary) button.className = "secondary";
  button.addEventListener("click", async () => {
    button.disabled = true;
    await onClick();
    button.disabled = false;
  });
  return button;
}

function renderTranscriptions(records) {
  transcriptionsCard.hidden = records.length === 0;
  transcriptionsList.replaceChildren(...records.map((record) => {
    const item = document.createElement("li");
    const title = document.createElement("p");
    title.className = "transcription-title";
    title.textContent = record.title;
    const { text, error } = describeTranscription(record);
    const status = document.createElement("p");
    status.className = error ? "transcription-status error" : "transcription-status";
    status.textContent = text;
    item.append(title, status);
    const actions = document.createElement("div");
    actions.className = "transcription-actions";
    if (record.state === "upload-failed") {
      actions.append(actionButton("Повторить", () =>
        sendTranscriptionMessage({ type: "TRANSCRIPTION_RETRY", localId: record.localId })));
    }
    if (isFinished(record)) {
      actions.append(actionButton("Удалить", () =>
        sendTranscriptionMessage({ type: "TRANSCRIPTION_REMOVE", localId: record.localId }), true));
    }
    if (actions.childElementCount) item.append(actions);
    return item;
  }));
}

async function loadShaiNoteState() {
  const { gmrAuth, gmrTranscriptions } = await chrome.storage.local.get(["gmrAuth", "gmrTranscriptions"]);
  shainoteAccount = gmrAuth ? { email: gmrAuth.email } : null;
  renderTranscriptionSetting();
  renderTranscriptions(gmrTranscriptions || []);
}

signinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  signinButton.disabled = true;
  signinStatus.textContent = "Входим…";
  const result = await sendTranscriptionMessage({
    type: "TRANSCRIPTION_SIGN_IN", email: signinEmail.value, password: signinPassword.value
  });
  signinButton.disabled = false;
  if (result?.ok) {
    signinPassword.value = "";
    signinStatus.textContent = "";
  } else {
    signinStatus.textContent = result?.error || "Не удалось войти";
  }
});

signoutButton.addEventListener("click", async () => {
  signoutButton.disabled = true;
  await sendTranscriptionMessage({ type: "TRANSCRIPTION_SIGN_OUT" });
  signoutButton.disabled = false;
});

transcriptionToggle.addEventListener("change", async () => {
  transcriptionToggle.disabled = true;
  try {
    renderSettings(await saveSettings({ transcriptionEnabled: transcriptionToggle.checked }));
  } catch (error) {
    console.error("[GMR][POPUP] transcription setting save failed:", error);
    transcriptionHint.textContent = "Не удалось сохранить настройку. Попробуйте ещё раз.";
  } finally {
    transcriptionToggle.disabled = !shainoteAccount;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.gmrSettings) renderSettings(normalizeSettings(changes.gmrSettings.newValue));
  if (changes.gmrAuth || changes.gmrTranscriptions) {
    loadShaiNoteState().catch((error) => console.error("[GMR][POPUP] ShaiNote state load failed:", error));
  }
});

loadShaiNoteState().catch((error) => console.error("[GMR][POPUP] ShaiNote state load failed:", error));

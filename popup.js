"use strict";

console.log("[GMR][POPUP] settings page loaded");

async function getUiMeetingTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  // A permission tab may return here. Keep its original invoked meeting target.
  const source = new URL(location.href).searchParams.get("meetingTabId");
  if (source && /^\d+$/.test(source) && active?.url?.startsWith(chrome.runtime.getURL(""))) {
    return chrome.tabs.get(Number(source));
  }
  return active;
}

async function notifyExtensionInvocation() {
  console.log("[GMR][POPUP] extension popup opened");
  let tab;
  try {
    tab = await getUiMeetingTab();
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
  return tab.id;
}

// Keep the invocation handoff independent of settings initialization.
const invocationReady = notifyExtensionInvocation();

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
    folderStatus.textContent = selectedDirectoryHandle.name;
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
      ? selectedDirectoryHandle.name
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
    const url = new URL(chrome.runtime.getURL("request-mic.html"));
    const meetingTabId = (await getUiMeetingTab())?.id;
    if (Number.isInteger(meetingTabId)) url.searchParams.set("meetingTabId", meetingTabId);
    await chrome.tabs.create({ url: url.href });
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
    microphonePermission = permission.state;
    permission.onchange = () => { microphonePermission = permission.state; renderUiState(); };
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
    microphonePermission = "unknown";
  }
}

let microphonePermission = "unknown";
checkMicrophonePermission().then(() => renderUiState());

// Presentation only: settings still save through the existing change handlers.
function updateSettingsSummary() {
  const saveMode = settingsForm.querySelector('input[name="saveMode"]:checked')?.value;
  document.getElementById("save-summary-title").textContent = {
    downloads: "Загрузки", ask: "Выбирать каждый раз", "selected-folder": "Папка на устройстве"
  }[saveMode] || "Загрузки";
  document.getElementById("save-summary-detail").textContent = saveMode === "selected-folder"
    ? (selectedDirectoryHandle?.name || "Папка ещё не выбрана")
    : saveMode === "ask" ? "Имя и папка — при сохранении" : "Автоматически после остановки";
  const permissionText = document.getElementById("microphone-status").textContent;
  const granted = permissionText === "Доступ к микрофону разрешён";
  document.getElementById("mic-setting-summary").textContent = !microphoneToggle.checked
    ? "Выключен — только звук вкладки"
    : granted ? "Готов — ваш голос будет в записи" : permissionText;
  document.querySelector(".permission").hidden = !microphoneToggle.checked || granted;
}

// The worker is the authority for recording; this variable only selects a settings view.
let settingsViewOpen = false;
let workerUiState = null;
let uiBusy = false;
let renderedScreen = null;
let popupTimer = null;
let uiRequestVersion = 0;
const liveUi = document.getElementById("live-ui");
const uiError = document.getElementById("ui-error");
const appShell = document.querySelector(".app-shell");
const mainActions = document.querySelector(".app-shell > .action-area");

function showUiError(message) {
  uiError.textContent = message || "";
  uiError.hidden = !message;
}

function showSaveSettings(show) {
  settingsViewOpen = show;
  renderUiState();
  if (show) document.getElementById("save-title").focus({ preventScroll: true });
}

function formatUiDuration(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, "0")).join(":");
}

function destinationLabel(data) {
  if (data?.destination && !["downloads", "selected-folder", "chosen-file"].includes(data.destination)) return data.destination;
  if (data?.destination === "downloads") return "Загрузки";
  if (data?.destination === "chosen-file") return "Выбранный файл";
  const mode = data?.settings?.saveMode;
  return mode === "selected-folder" ? data?.folderName || "Выбранная папка"
    : mode === "ask" ? "Выбирать каждый раз" : "Загрузки";
}

function updatePopupTimer() {
  const timer = liveUi.querySelector(".large-timer");
  const recording = workerUiState?.recording;
  if (!timer) return;
  timer.hidden = !Number.isFinite(recording?.startedAt);
  if (!timer.hidden) timer.textContent = formatUiDuration((recording.stoppedAt || Date.now()) - recording.startedAt);
}

function renderUiState() {
  const state = workerUiState;
  const active = state && state.captureState !== "idle";
  const saved = state?.saved;
  const needsPermission = microphoneToggle.checked && microphonePermission !== "granted";
  const screen = active ? "active" : saved ? "saved" : settingsViewOpen ? "save" : needsPermission ? "permission" : "new";
  appShell.dataset.screen = screen;
  settingsForm.hidden = !["new", "save"].includes(screen);
  mainActions.hidden = settingsForm.hidden;
  document.getElementById("new-recording").hidden = screen !== "new";
  document.getElementById("save-settings").hidden = screen !== "save";
  document.getElementById("new-actions").hidden = screen !== "new";
  document.getElementById("save-actions").hidden = screen !== "save";
  const showBack = screen === "save" || screen === "saved";
  document.getElementById("back-arrow").hidden = !showBack;
  document.getElementById("back-arrow").disabled = uiBusy;
  document.getElementById("back-arrow").setAttribute("aria-label", screen === "saved" ? "На главную" : "Назад к записи");
  document.getElementById("back-to-recording").hidden = !showBack;
  document.getElementById("back-to-recording").disabled = uiBusy;
  document.getElementById("back-to-recording").textContent = screen === "saved" ? "На главную" : "Назад к записи";
  liveUi.hidden = !settingsForm.hidden;
  if (renderedScreen !== screen) {
    clearInterval(popupTimer);
    popupTimer = null;
    liveUi.replaceChildren();
    const template = screen === "permission" ? "permission-template"
      : ["active", "saved"].includes(screen) ? `recording-${screen}-template` : null;
    if (template) liveUi.append(document.getElementById(template).content.cloneNode(true));
    if (screen === "active") popupTimer = setInterval(updatePopupTimer, 250);
    renderedScreen = screen;
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    window.scrollTo(0, 0);
  }
  document.getElementById("start-recording").disabled = !state || uiBusy || settingsControls.disabled;
  document.getElementById("save-settings-done").disabled = uiBusy || settingsControls.disabled;
  if (screen === "active") {
    const recording = state.recording;
    const label = liveUi.querySelector(".recording-label");
    const pending = recording?.stoppedAt;
    label.lastChild.textContent = state.captureState === "starting" ? "Запуск записи…"
      : state.captureState === "stopping" ? "Сохранение…" : pending ? "Запись ожидает сохранения" : "Идёт запись";
    const stop = document.getElementById("stop-recording");
    stop.disabled = uiBusy || ["starting", "stopping"].includes(state.captureState);
    stop.textContent = pending && state.captureState === "capturing" ? "Повторить сохранение" : "Остановить и сохранить";
    const values = {
      "[data-recording-mode]": recording?.settings ? `Вкладка браузера · ${recording.settings.recordingMode === "audio-video" ? "Аудио + видео" : "Только аудио"}` : null,
      "[data-recording-mic]": recording?.settings ? recording.settings.microphoneEnabled ? "Включён — записывает ваш голос" : "Выключен — только звук вкладки" : null,
      "[data-recording-folder]": recording?.settings ? destinationLabel(recording) : null
    };
    for (const [selector, value] of Object.entries(values)) {
      const element = liveUi.querySelector(selector);
      element.textContent = value || "";
      element.closest(".icon-row").hidden = !value;
    }
    updatePopupTimer();
  }
  if (screen === "saved") {
    const complete = saved.downloadState === "complete";
    liveUi.querySelector(".success-icon .icon").src = saved.downloadState === "interrupted"
      ? "assets/ui/x.svg" : "assets/ui/check.svg";
    liveUi.querySelector("h1").textContent = complete ? "Запись сохранена" : saved.downloadState === "interrupted" ? "Сохранение прервано" : "Файл сохраняется";
    liveUi.querySelector(".subtitle").textContent = complete ? "Файл сохранён на этом устройстве." : "Проверьте загрузки браузера.";
    liveUi.querySelector(".saved-file").hidden = !saved.filename;
    liveUi.querySelector(".saved-filename").textContent = saved.filename || "";
    const metadata = [saved.settings?.recordingMode === "audio-video" ? "Аудио + видео" : "Только аудио"];
    if (Number.isFinite(saved.durationMs)) metadata.push(formatUiDuration(saved.durationMs));
    if (Number.isFinite(saved.size)) metadata.push(`${(saved.size / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`);
    const meta = liveUi.querySelector(".saved-metadata");
    meta.hidden = false; meta.textContent = metadata.join(" · ");
    liveUi.querySelector(".saved-location").hidden = false;
    liveUi.querySelector("[data-saved-folder]").textContent = destinationLabel(saved);
  }
  if (screen === "permission") {
    document.getElementById("popup-allow-microphone").disabled = uiBusy;
    document.getElementById("popup-without-mic").disabled = uiBusy || settingsControls.disabled;
  }
  updateSettingsSummary();
}

async function refreshUiState() {
  const version = ++uiRequestVersion;
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_UI_STATE" });
    if (version !== uiRequestVersion) return;
    if (!state?.ok) throw new Error(state?.message || "Состояние записи недоступно");
    workerUiState = state;
    renderUiState();
  } catch (error) { showUiError(error.message); }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "UI_STATE_UPDATED") return false;
  ++uiRequestVersion;
  workerUiState = message.state;
  if (message.state.error) showUiError(message.state.error.message);
  renderUiState();
  return false;
});

async function runUiAction(action) {
  if (uiBusy) return;
  uiBusy = true; showUiError(""); renderUiState();
  try { await action(); }
  catch (error) { showUiError(error.message || String(error)); }
  finally { uiBusy = false; await refreshUiState(); renderUiState(); }
}

document.getElementById("start-recording").addEventListener("click", () => runUiAction(async () => {
  await saveQueue;
  await invocationReady;
  const tab = await getUiMeetingTab();
  if (!Number.isInteger(tab?.id)) throw new Error("Откройте вкладку активной встречи.");
  let result;
  try { result = await chrome.tabs.sendMessage(tab.id, { type: "UI_START_RECORDING" }); }
  catch { throw new Error("Откройте активную встречу Meet, Teams или Zoom и обновите её вкладку."); }
  if (!result?.ok) throw new Error(result?.message || "Активная встреча не найдена.");
}));

liveUi.addEventListener("click", (event) => {
  const id = event.target.closest("button")?.id;
  if (id === "stop-recording") void runUiAction(async () => {
    const result = await chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
    if (!result?.ok) throw new Error(result?.message || "Не удалось сохранить запись");
  });
  if (id === "new-recording-action") returnToMain();
  if (id === "popup-allow-microphone") enableButton.click();
  if (id === "popup-without-mic") void runUiAction(async () => {
    renderSettings(await saveSettings({ microphoneEnabled: false }));
    settingsViewOpen = false;
  });
});

document.getElementById("edit-save-settings").addEventListener("click", () => showSaveSettings(true));
function returnToMain() {
  if (!workerUiState?.saved) { showSaveSettings(false); return; }
  void runUiAction(async () => {
    const result = await chrome.runtime.sendMessage({ type: "CLEAR_UI_SAVED" });
    if (!result?.ok) throw new Error(result?.message || "Не удалось вернуться на главную");
    settingsViewOpen = false;
  });
}
document.getElementById("back-to-recording").addEventListener("click", returnToMain);
document.getElementById("back-arrow").addEventListener("click", returnToMain);
document.getElementById("save-settings-done").addEventListener("click", () => runUiAction(async () => {
  const settings = normalizeSettings(Object.fromEntries(new FormData(settingsForm)));
  settings.microphoneEnabled = microphoneToggle.checked;
  renderSettings(await saveSettings(settings));
  settingsViewOpen = false;
}));
new MutationObserver(renderUiState).observe(settingsControls, { attributes: true, attributeFilter: ["disabled"] });
new MutationObserver(updateSettingsSummary).observe(microphoneStatus, { childList: true });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.gmrSettings) {
    renderSettings(normalizeSettings(changes.gmrSettings.newValue));
    renderUiState();
  }
});
window.addEventListener("focus", () => {
  userRequestStarted = false;
  void checkMicrophonePermission().then(() => renderUiState());
  void refreshUiState();
});
void refreshUiState();

liveUi.addEventListener("change", (event) => {
  if (event.target.id === "popup-permission-toggle" && !event.target.checked) {
    document.getElementById("popup-without-mic").click();
  }
});

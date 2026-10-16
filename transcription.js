"use strict";

// Transcription: sends a Recording's Meeting Audio to ShaiNote and saves the
// Transcript and Summary next to the Recording. All browser effects are
// injected, so this file runs both in the service worker and under node --test.
(function (root) {
  const API_BASE = "https://shainote.ai/api/v1";
  const RECORDS_KEY = "gmrTranscriptions";
  const AUTH_KEY = "gmrAuth";
  const MIN_DURATION_MS = 30 * 1000;
  const SIGN_IN_AGAIN = "Войдите в ShaiNote и нажмите «Повторить»";
  const NO_SPEECH = "Речь не распознана";
  const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
  const SUMMARY_TIMEOUT_MS = 30 * 60 * 1000;
  const TRANSCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
  const MAX_RECORDS = 20;

  const UPLOAD_ERRORS = {
    file_too_large: "Файл слишком большой для ShaiNote",
    invalid_file_type: "ShaiNote не принял формат файла",
    active_limit_reached: "Достигнут лимит активных встреч в ShaiNote",
    too_many_requests: "Слишком много запросов к ShaiNote, повторите позже",
    temporarily_unavailable: "ShaiNote временно недоступен"
  };

  const SIGN_IN_ERRORS = {
    invalid_credentials: "Неверный email или пароль",
    user_inactive: "Аккаунт ShaiNote не активирован. Подтвердите email.",
    too_many_requests: "Слишком много попыток входа, повторите позже"
  };

  function describeUploadError(result) {
    if (result.networkError) return "Нет соединения с ShaiNote";
    if (result.status === 401) return SIGN_IN_AGAIN;
    if (result.missingAudio) return "Аудио для повторной отправки не найдено";
    return UPLOAD_ERRORS[result.body?.status] || `Ошибка ShaiNote (${result.status})`;
  }

  class SignedOutError extends Error {
    constructor() { super(SIGN_IN_AGAIN); }
  }

  function createTranscription(deps) {
    const { fetch, storage, now, notify } = deps;
    let queue = Promise.resolve();

    // Serialize every operation: events from alarms, offscreen and the popup interleave.
    function exclusive(operation) {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    }

    async function loadRecords() { return (await storage.get(RECORDS_KEY)) || []; }
    async function saveRecords(records) { await storage.set(RECORDS_KEY, records); }
    async function updateRecord(localId, patch) {
      const records = await loadRecords();
      const record = records.find((item) => item.localId === localId);
      if (!record) return null;
      Object.assign(record, patch, { updatedAt: now() });
      await saveRecords(records);
      return record;
    }

    async function storeTokens(tokens, email) {
      const auth = {
        email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: now() + tokens.expires_in * 1000
      };
      await storage.set(AUTH_KEY, auth);
      return auth;
    }

    // Returns a fresh access token, or null once ShaiNote refuses the refresh token.
    async function refreshAccessToken() {
      const auth = await storage.get(AUTH_KEY);
      if (!auth) return null;
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST", body: new URLSearchParams({ refresh_token: auth.refreshToken })
      });
      if (response.ok) return (await storeTokens(await response.json(), auth.email)).accessToken;
      if (response.status === 400 || response.status === 401) {
        await storage.remove(AUTH_KEY);
        return null;
      }
      throw new Error(`Token refresh failed (${response.status})`);
    }

    async function getAccessToken() {
      const auth = await storage.get(AUTH_KEY);
      if (!auth) return null;
      if (auth.expiresAt - now() < TOKEN_REFRESH_MARGIN_MS) return await refreshAccessToken();
      return auth.accessToken;
    }

    async function api(path, init = {}) {
      const send = (token) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`);
        return fetch(`${API_BASE}${path}`, { ...init, headers });
      };
      let token = await getAccessToken();
      if (!token) throw new SignedOutError();
      let response = await send(token);
      if (response.status !== 401) return response;
      token = await refreshAccessToken();
      if (!token) throw new SignedOutError();
      response = await send(token);
      if (response.status === 401) throw new SignedOutError();
      return response;
    }

    async function signIn(email, password) {
      const body = new URLSearchParams({ grant_type: "password", username: email, password });
      let response;
      try {
        response = await fetch(`${API_BASE}/auth/login`, { method: "POST", body });
      } catch {
        return { ok: false, error: "Нет соединения с ShaiNote" };
      }
      if (!response.ok) {
        const status = (await response.json().catch(() => null))?.status;
        return { ok: false, error: SIGN_IN_ERRORS[status] || `Не удалось войти (${response.status})` };
      }
      await storeTokens(await response.json(), email);
      return { ok: true };
    }

    async function signOut() {
      const auth = await storage.get(AUTH_KEY);
      await storage.remove(AUTH_KEY);
      if (!auth) return;
      try {
        await fetch(`${API_BASE}/auth/logout`, {
          method: "POST",
          headers: { authorization: `Bearer ${auth.accessToken}` },
          body: new URLSearchParams({ refresh_token: auth.refreshToken })
        });
      } catch (error) {
        // The local session is gone either way; the refresh token just expires on its own.
        console.warn("[GMR][TRANSCRIPTION] logout request failed", error);
      }
    }

    async function recordingSaved(recording) {
      const record = {
        localId: recording.localId,
        recordingName: recording.recordingName,
        title: recording.title,
        meetingUrl: recording.meetingUrl,
        saveMode: recording.saveMode,
        durationMs: recording.durationMs,
        createdAt: now(),
        updatedAt: now(),
        state: "uploading",
        jobId: null,
        serverStatus: null,
        transcript: "pending",
        summary: "pending",
        summaryId: null,
        error: null
      };
      if (!(recording.durationMs >= MIN_DURATION_MS)) record.state = "too-short";
      else if (recording.silent) record.state = "silent";
      const records = await loadRecords();
      records.unshift(record);
      // Keep the list short: drop the oldest finished entries beyond the cap.
      while (records.length > MAX_RECORDS) {
        const index = records.findLastIndex((item) => !isActive(item));
        if (index < 0) break;
        const [dropped] = records.splice(index, 1);
        await deps.deleteMeetingAudio(dropped.localId);
      }
      await saveRecords(records);
      if (record.state === "too-short") {
        await deps.deleteMeetingAudio(record.localId);
        // The popup has no list, so a skipped Recording must still say so.
        await notify("Транскрипция не создана", `${record.title}: запись короче 30 секунд`);
      } else if (record.state === "silent") {
        await deps.deleteMeetingAudio(record.localId);
        await notify("Транскрипция не создана", `${record.title}: в записи нет звука, аудио не отправлено`);
      } else {
        await startUpload(record);
      }
    }

    async function startUpload(record, accessToken) {
      try {
        accessToken ??= await getAccessToken();
      } catch (error) {
        console.warn("[GMR][TRANSCRIPTION] token refresh failed", error);
        await failUpload(record.localId, describeUploadError({ networkError: true }));
        return;
      }
      if (!accessToken) {
        await failUpload(record.localId, SIGN_IN_AGAIN);
        return;
      }
      await deps.requestUpload({
        localId: record.localId,
        filename: `${record.recordingName}.wav`,
        url: `${API_BASE}/meetings/upload`,
        accessToken
      });
    }

    async function failUpload(localId, error) {
      const record = await updateRecord(localId, { state: "upload-failed", error });
      if (record) await notify("Не удалось отправить аудио в ShaiNote", `${record.title}: ${error}`, { retryLocalId: localId });
    }

    async function retry(localId) {
      const existing = (await loadRecords()).find((item) => item.localId === localId);
      if (existing?.state !== "upload-failed") return;
      const record = await updateRecord(localId, { state: "uploading", error: null, uploadAuthRetried: false });
      await startUpload(record);
    }

    async function uploadFinished(result) {
      const jobId = result.body?.job_id;
      if (result.status === 401) {
        // The upload carried a stale token: refresh and resend once.
        const record = (await loadRecords()).find((item) => item.localId === result.localId);
        if (record && !record.uploadAuthRetried) {
          await updateRecord(record.localId, { uploadAuthRetried: true });
          const accessToken = await refreshAccessToken();
          if (accessToken) {
            await startUpload(record, accessToken);
            return;
          }
        }
      }
      if (result.networkError || !(result.status >= 200 && result.status < 300) || !jobId) {
        await failUpload(result.localId, describeUploadError(result));
        return;
      }
      const record = await updateRecord(result.localId, { state: "processing", jobId, error: null });
      await deps.deleteMeetingAudio(result.localId);
      if (!record) return;
      await notify("Аудио отправлено в ShaiNote", `${record.title}: транскрипция и сводка сохранятся рядом с записью`);
      try {
        await api(`/meetings/${jobId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: record.title, meeting_url: record.meetingUrl })
        });
      } catch (error) {
        // Only cosmetic on shainote.ai; the Job itself is unaffected.
        console.warn("[GMR][TRANSCRIPTION] meeting title update failed", error);
      }
    }


    async function saveDocument(record, kind, response) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const filename = `${record.recordingName}_${kind}.pdf`;
      // "Ask every time" saves silently too: a Save dialog minutes after the meeting is confusing.
      const inFolder = record.saveMode === "selected-folder" && await deps.writeToFolder(filename, bytes);
      if (!inFolder) await deps.download(filename, bytes);
      return filename;
    }

    async function advance(record) {
      if (record.state === "processing") {
        const response = await api(`/meetings/status/${record.jobId}`);
        if (!response.ok) return;
        const status = await response.json();
        record.serverStatus = status.status;
        if (status.status === "completed") {
          record.state = "completed";
          record.completedAt = now();
        }
        if (status.status === "failed" || status.status === "cancelled") {
          record.state = "failed";
          record.error = status.message || "Обработка не удалась";
          await notify("ShaiNote не смог обработать запись", `${record.title}: ${record.error}`);
        }
      }
      if (record.state === "completed" && record.transcript === "pending") {
        await advanceTranscript(record);
      }
      if (record.state === "completed" && ["pending", "waiting"].includes(record.summary)) {
        await advanceSummary(record);
      }
    }

    async function advanceTranscript(record) {
      const response = await api(`/meetings/transcript/${record.jobId}?format=pdf`);
      if (response.ok) {
        const filename = await saveDocument(record, "transcript", response);
        record.transcript = "saved";
        await notify("Транскрипция готова", `${record.title}: ${filename}`);
        return;
      }
      record.transcriptStatus = response.status;
      if (await heardNoSpeech(record)) {
        // The Summary of an empty Transcript only says there was nothing to summarize.
        record.transcript = "failed";
        record.summary = "failed";
        record.noSpeech = true;
        await notify(NO_SPEECH, `${record.title}: ShaiNote не нашёл речи в записи, транскрипция и сводка не созданы`);
        return;
      }
      if (now() - record.completedAt > TRANSCRIPT_TIMEOUT_MS) {
        record.transcript = "failed";
        await notify("Транскрипция недоступна", `${record.title}: откройте встречу на shainote.ai`);
      }
    }

    // A completed Job with no speech answers the Transcript download with 404
    // "Transcript not ready" forever; its meeting shows an empty transcript_content.
    async function heardNoSpeech(record) {
      const response = await api(`/meetings/${record.jobId}`);
      if (!response.ok) return false;
      const { transcript_content: content } = await response.json();
      return Array.isArray(content) ? content.length === 0 : content === "";
    }

    // A Job may or may not come with a Summary: use ShaiNote's own, else request one.
    async function advanceSummary(record) {
      let summary;
      if (record.summary === "pending") {
        const response = await api(`/meeting-summaries?meeting_job_id=${record.jobId}`);
        const { summaries = [] } = response.ok ? await response.json() : {};
        summary = summaries.find((item) => item.status === "completed" && item.has_pdf) ||
          summaries.find((item) => item.status === "pending" || item.status === "processing");
        if (!summary) {
          const created = await api(`/meeting-summaries?meeting_job_id=${record.jobId}`, { method: "POST" });
          if (!created.ok) return await failSummary(record);
          summary = await created.json();
        }
        record.summaryId = summary.id;
        record.summary = "waiting";
      } else {
        const response = await api(`/meeting-summaries/${record.summaryId}`);
        if (response.ok) summary = await response.json();
      }
      if (summary?.status === "completed" && summary.has_pdf) {
        const pdf = await api(`/meetings/summary?summary_id=${summary.id}&format=pdf`);
        if (pdf.ok) {
          const filename = await saveDocument(record, "summary", pdf);
          record.summary = "saved";
          await notify("Сводка готова", `${record.title}: ${filename}`);
          return;
        }
      }
      if (summary?.status === "failed" || now() - record.completedAt > SUMMARY_TIMEOUT_MS) {
        await failSummary(record);
      }
    }

    async function failSummary(record) {
      record.summary = "failed";
      await notify("Сводка недоступна", `${record.title}: транскрипция сохранена, сводку не удалось получить`);
    }

    async function tick() {
      const activeIds = (await loadRecords()).filter(isActive).map((record) => record.localId);
      for (const localId of activeIds) {
        const record = (await loadRecords()).find((item) => item.localId === localId);
        if (!record) continue;
        if (record.state === "uploading") {
          // Uploads die with the offscreen document, e.g. on browser restart.
          if (!(await deps.isUploadInFlight(localId))) await startUpload(record);
          continue;
        }
        try {
          await advance(record);
          if (record.state !== "failed") record.error = null;
        } catch (error) {
          // Anything else is transient: the next tick tries again.
          if (error instanceof SignedOutError) record.error = "Войдите в ShaiNote, чтобы получить транскрипцию";
          else console.warn("[GMR][TRANSCRIPTION] tick failed for", localId, error);
        }
        await updateRecord(localId, record);
      }
    }

    function isActive(record) {
      if (record.state === "uploading" || record.state === "processing") return true;
      return record.state === "completed" &&
        (record.transcript === "pending" || record.summary === "pending" || record.summary === "waiting");
    }

    return {
      signIn: (email, password) => exclusive(() => signIn(email, password)),
      signOut: () => exclusive(signOut),
      recordingSaved: (recording) => exclusive(() => recordingSaved(recording)),
      uploadFinished: (result) => exclusive(() => uploadFinished(result)),
      retry: (localId) => exclusive(() => retry(localId)),
      account: () => exclusive(async () => {
        const auth = await storage.get(AUTH_KEY);
        return auth ? { email: auth.email } : null;
      }),
      tick: () => exclusive(tick),
      list: () => exclusive(loadRecords),
      needsPolling: () => exclusive(async () => (await loadRecords()).some(isActive))
    };
  }

  const exported = { createTranscription, API_BASE };
  if (typeof module === "object" && module.exports) module.exports = exported;
  else root.GMRTranscription = exported;
})(typeof globalThis !== "undefined" ? globalThis : this);

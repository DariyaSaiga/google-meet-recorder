"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTranscription } = require("../transcription.js");
const { createFakeShaiNote, createFakeBrowser } = require("./fake-shainote.js");

function setup() {
  const shainote = createFakeShaiNote();
  const browser = createFakeBrowser();
  const transcription = createTranscription({ fetch: shainote.fetch, ...browser.deps });
  return { shainote, browser, transcription };
}

const RECORDING = {
  localId: "rec-1",
  recordingName: "Meet_abc-defg-hij_2026-10-15_18-30",
  title: "Google Meet abc-defg-hij · 2026-10-15 18:30",
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  saveMode: "downloads",
  durationMs: 45 * 60 * 1000
};

// Plays the offscreen document: answers the latest upload request.
async function finishUpload({ shainote, browser, transcription }, options) {
  const request = browser.uploadRequests.at(-1);
  browser.uploadsInFlight.delete(request.localId);
  await transcription.uploadFinished({ localId: request.localId, ...shainote.acceptUpload(request.accessToken, options) });
}

async function recordAndUpload(ctx, recording = RECORDING) {
  await ctx.transcription.recordingSaved(recording);
  await finishUpload(ctx);
  return [...ctx.shainote.server.jobs.keys()].at(-1);
}

test("a saved Recording ends with its Transcript and Summary saved next to it", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  assert.equal((await transcription.signIn("me@example.com", "secret")).ok, true);
  browser.meetingAudio.add("rec-1");

  const jobId = await recordAndUpload(ctx);
  assert.equal(browser.uploadRequests[0].filename, "Meet_abc-defg-hij_2026-10-15_18-30.webm");
  assert.deepEqual(shainote.server.jobs.get(jobId), {
    status: "queued",
    title: "Google Meet abc-defg-hij · 2026-10-15 18:30",
    meetingUrl: "https://meet.google.com/abc-defg-hij"
  });
  assert.equal(browser.meetingAudio.has("rec-1"), false, "Meeting Audio is dropped once ShaiNote accepts it");

  shainote.server.jobs.get(jobId).status = "transcribing";
  await transcription.tick();
  assert.equal((await transcription.list())[0].serverStatus, "transcribing");
  assert.equal(browser.downloads.length, 0);

  shainote.server.jobs.get(jobId).status = "completed";
  shainote.server.summaries.set("s-auto", { jobId, status: "completed", hasPdf: true });
  await transcription.tick();

  assert.deepEqual(browser.downloads, [
    { filename: "Meet_abc-defg-hij_2026-10-15_18-30_transcript.pdf", text: `%PDF transcript ${jobId} pdf` },
    { filename: "Meet_abc-defg-hij_2026-10-15_18-30_summary.pdf", text: "%PDF summary s-auto pdf" }
  ]);
  assert.deepEqual(browser.notifications.map((n) => n.title), ["Расшифровка готова", "Резюме готово"]);
  const [record] = await transcription.list();
  assert.equal(record.transcript, "saved");
  assert.equal(record.summary, "saved");
  assert.equal(await transcription.needsPolling(), false);
});

test("a Recording under 30 seconds is not sent and shows as too short", async () => {
  const { browser, transcription } = setup();
  await transcription.signIn("me@example.com", "secret");
  browser.meetingAudio.add("rec-1");

  await transcription.recordingSaved({ ...RECORDING, durationMs: 29_000 });

  assert.equal(browser.uploadRequests.length, 0);
  assert.equal(browser.meetingAudio.has("rec-1"), false);
  const [record] = await transcription.list();
  assert.equal(record.state, "too-short");
  assert.equal(await transcription.needsPolling(), false);
});

test("a Recording saved while signed out can be retried after signing in", async () => {
  const ctx = setup();
  const { browser, transcription } = ctx;
  browser.meetingAudio.add("rec-1");

  await transcription.recordingSaved(RECORDING);

  assert.equal(browser.uploadRequests.length, 0);
  let [record] = await transcription.list();
  assert.equal(record.state, "upload-failed");
  assert.match(record.error, /Войдите в ShaiNote/);
  assert.equal(browser.meetingAudio.has("rec-1"), true, "Meeting Audio is kept for Retry");
  assert.deepEqual(browser.notifications.map((n) => n.title), ["Не удалось отправить аудио в ShaiNote"]);
  assert.equal(await transcription.needsPolling(), false);

  await transcription.signIn("me@example.com", "secret");
  await transcription.retry("rec-1");
  await finishUpload(ctx);

  [record] = await transcription.list();
  assert.equal(record.state, "processing");
  assert.equal(record.error, null);
  assert.equal(browser.meetingAudio.has("rec-1"), false);
});

test("an upload ShaiNote rejects keeps the Meeting Audio and explains why", async () => {
  const ctx = setup();
  const { browser, transcription } = ctx;
  await transcription.signIn("me@example.com", "secret");
  browser.meetingAudio.add("rec-1");

  await transcription.recordingSaved(RECORDING);
  await finishUpload(ctx, { error: "file_too_large" });

  const [record] = await transcription.list();
  assert.equal(record.state, "upload-failed");
  assert.equal(record.error, "Файл слишком большой для ShaiNote");
  assert.equal(browser.meetingAudio.has("rec-1"), true);
  assert.equal(browser.notifications.at(-1).title, "Не удалось отправить аудио в ShaiNote");
});

test("an upload that never reaches ShaiNote can be retried", async () => {
  const { browser, transcription } = setup();
  await transcription.signIn("me@example.com", "secret");
  browser.meetingAudio.add("rec-1");

  await transcription.recordingSaved(RECORDING);
  browser.uploadsInFlight.clear();
  await transcription.uploadFinished({ localId: "rec-1", networkError: "Failed to fetch" });

  const [record] = await transcription.list();
  assert.equal(record.state, "upload-failed");
  assert.equal(record.error, "Нет соединения с ShaiNote");
});

test("an expired sign-in is refreshed silently while following a Job", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  await transcription.signIn("me@example.com", "secret");
  const jobId = await recordAndUpload(ctx);

  shainote.server.tokens.clear(); // ShaiNote no longer accepts the access token
  shainote.server.jobs.get(jobId).status = "merging";
  await transcription.tick();

  assert.equal((await transcription.list())[0].serverStatus, "merging");
  assert.ok(shainote.server.calls.includes("POST /auth/refresh"));

  // The refreshed token keeps working without another refresh.
  browser.now += 60_000;
  await transcription.tick();
  assert.equal(shainote.server.calls.filter((c) => c === "POST /auth/refresh").length, 1);
});

test("an access token past its expiry is refreshed before uploading", async () => {
  const { shainote, browser, transcription } = setup();
  shainote.server.expiresIn = 60;
  await transcription.signIn("me@example.com", "secret");
  browser.now += 2 * 60_000;

  await transcription.recordingSaved(RECORDING);

  assert.equal(browser.uploadRequests[0].accessToken, "access-2");
  assert.ok(shainote.server.calls.includes("POST /auth/refresh"));
});

test("an upload refused for authentication is retried once with a refreshed token", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  await transcription.signIn("me@example.com", "secret");
  await transcription.recordingSaved(RECORDING);

  shainote.server.tokens.clear();
  await finishUpload(ctx);
  assert.equal(browser.uploadRequests.length, 2);
  assert.equal(browser.uploadRequests[1].accessToken, "access-2");

  await finishUpload(ctx);
  assert.equal((await transcription.list())[0].state, "processing");
});

test("when the sign-in can't be refreshed, the user is signed out and asked to sign in again", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  await transcription.signIn("me@example.com", "secret");
  await transcription.recordingSaved(RECORDING);

  shainote.server.tokens.clear();
  shainote.server.refreshTokens.clear();
  await finishUpload(ctx);

  const [record] = await transcription.list();
  assert.equal(record.state, "upload-failed");
  assert.match(record.error, /Войдите в ShaiNote/);
  assert.equal(await transcription.account(), null);
  assert.equal(browser.uploadRequests.length, 1);
});

test("a Job that fails on ShaiNote is reported with its reason and no longer followed", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  await transcription.signIn("me@example.com", "secret");
  const jobId = await recordAndUpload(ctx);

  Object.assign(shainote.server.jobs.get(jobId), { status: "failed", message: "No speech detected" });
  await transcription.tick();

  const [record] = await transcription.list();
  assert.equal(record.state, "failed");
  assert.equal(record.error, "No speech detected");
  assert.deepEqual(browser.notifications.at(-1), {
    title: "ShaiNote не смог обработать запись",
    message: "Google Meet abc-defg-hij · 2026-10-15 18:30: No speech detected"
  });
  assert.equal(browser.downloads.length, 0);
  assert.equal(await transcription.needsPolling(), false);
});

async function completeJob(ctx) {
  await ctx.transcription.signIn("me@example.com", "secret");
  const jobId = await recordAndUpload(ctx);
  ctx.shainote.server.jobs.get(jobId).status = "completed";
  return jobId;
}

test("when ShaiNote made no Summary, one is requested with the default template and saved once ready", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  const jobId = await completeJob(ctx);

  await transcription.tick();
  assert.deepEqual(browser.downloads.map((d) => d.filename), ["Meet_abc-defg-hij_2026-10-15_18-30_transcript.pdf"]);
  assert.ok(shainote.server.calls.includes(`POST /meeting-summaries?meeting_job_id=${jobId}`));
  assert.equal((await transcription.list())[0].summary, "waiting");

  await transcription.tick();
  assert.equal(browser.downloads.length, 1, "nothing to save while the Summary is processing");
  assert.equal(shainote.server.calls.filter((c) => c.startsWith("POST /meeting-summaries")).length, 1);

  Object.assign(shainote.server.summaries.get("summary-1"), { status: "completed", hasPdf: true });
  await transcription.tick();
  assert.deepEqual(browser.downloads.at(-1), {
    filename: "Meet_abc-defg-hij_2026-10-15_18-30_summary.pdf", text: "%PDF summary summary-1 pdf"
  });
  assert.equal(await transcription.needsPolling(), false);
});

test("a Summary already being generated by ShaiNote is waited for, not requested again", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  const jobId = await completeJob(ctx);
  shainote.server.summaries.set("s-auto", { jobId, status: "processing", hasPdf: false });

  await transcription.tick();
  shainote.server.summaries.get("s-auto").status = "completed";
  shainote.server.summaries.get("s-auto").hasPdf = true;
  await transcription.tick();

  assert.equal(shainote.server.calls.some((c) => c.startsWith("POST /meeting-summaries")), false);
  assert.equal(browser.downloads.at(-1).text, "%PDF summary s-auto pdf");
});

test("a failed Summary keeps the Transcript and reports only the Summary as failed", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  await completeJob(ctx);
  await transcription.tick();

  shainote.server.summaries.get("summary-1").status = "failed";
  await transcription.tick();

  const [record] = await transcription.list();
  assert.equal(record.state, "completed");
  assert.equal(record.transcript, "saved");
  assert.equal(record.summary, "failed");
  assert.equal(browser.notifications.at(-1).title, "Резюме недоступно");
  assert.equal(await transcription.needsPolling(), false);
});

test("a Summary that isn't ready 30 minutes after the Job completed is given up on", async () => {
  const ctx = setup();
  const { browser, transcription } = ctx;
  await completeJob(ctx);
  await transcription.tick();

  browser.now += 31 * 60_000;
  await transcription.tick();

  assert.equal((await transcription.list())[0].summary, "failed");
  assert.equal(browser.downloads.length, 1);
});

test("with a chosen folder, the documents are written there", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  await transcription.signIn("me@example.com", "secret");
  const jobId = await recordAndUpload(ctx, { ...RECORDING, saveMode: "selected-folder" });
  shainote.server.jobs.get(jobId).status = "completed";
  shainote.server.summaries.set("s-auto", { jobId, status: "completed", hasPdf: true });

  await transcription.tick();

  assert.deepEqual(browser.folderFiles.map((f) => f.filename), [
    "Meet_abc-defg-hij_2026-10-15_18-30_transcript.pdf",
    "Meet_abc-defg-hij_2026-10-15_18-30_summary.pdf"
  ]);
  assert.equal(browser.downloads.length, 0);
});

test("when the chosen folder is unavailable, the documents go to Downloads", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  browser.folderAvailable = false;
  await transcription.signIn("me@example.com", "secret");
  const jobId = await recordAndUpload(ctx, { ...RECORDING, saveMode: "selected-folder" });
  shainote.server.jobs.get(jobId).status = "completed";

  await transcription.tick();

  assert.deepEqual(browser.downloads.map((d) => d.filename), ["Meet_abc-defg-hij_2026-10-15_18-30_transcript.pdf"]);
});

test("with \"ask every time\", the documents go to Downloads without asking", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  await transcription.signIn("me@example.com", "secret");
  const jobId = await recordAndUpload(ctx, { ...RECORDING, saveMode: "ask" });
  shainote.server.jobs.get(jobId).status = "completed";

  await transcription.tick();

  assert.deepEqual(browser.downloads.map((d) => d.filename), ["Meet_abc-defg-hij_2026-10-15_18-30_transcript.pdf"]);
  assert.equal(browser.folderFiles.length, 0);
});

test("after a browser restart, a processing Job is still followed to its documents", async () => {
  const ctx = setup();
  const { shainote, browser } = ctx;
  await ctx.transcription.signIn("me@example.com", "secret");
  const jobId = await recordAndUpload(ctx);

  const restarted = createTranscription({ fetch: shainote.fetch, ...browser.deps });
  assert.equal(await restarted.needsPolling(), true);
  shainote.server.jobs.get(jobId).status = "completed";
  await restarted.tick();

  assert.equal(browser.downloads[0].filename, "Meet_abc-defg-hij_2026-10-15_18-30_transcript.pdf");
});

test("after a browser restart, an interrupted upload starts again", async () => {
  const ctx = setup();
  const { shainote, browser } = ctx;
  await ctx.transcription.signIn("me@example.com", "secret");
  await ctx.transcription.recordingSaved(RECORDING);

  browser.uploadsInFlight.clear(); // the offscreen document died with the browser
  const restarted = createTranscription({ fetch: shainote.fetch, ...browser.deps });
  await restarted.tick();
  assert.equal(browser.uploadRequests.length, 2);

  await restarted.tick();
  assert.equal(browser.uploadRequests.length, 2, "an upload still in flight is left alone");
});

test("a network hiccup while following one Job doesn't stop the others", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  await transcription.signIn("me@example.com", "secret");
  const first = await recordAndUpload(ctx);
  const second = await recordAndUpload(ctx, { ...RECORDING, localId: "rec-2", recordingName: "Meet_second" });
  shainote.server.jobs.get(first).status = "completed";
  shainote.server.jobs.get(second).status = "completed";

  shainote.server.override = (method, path) => {
    if (path === `/meetings/status/${second}`) throw new TypeError("Failed to fetch");
  };
  await transcription.tick();
  assert.deepEqual(browser.downloads.map((d) => d.filename), ["Meet_abc-defg-hij_2026-10-15_18-30_transcript.pdf"]);

  shainote.server.override = null;
  await transcription.tick();
  assert.ok(browser.downloads.some((d) => d.filename === "Meet_second_transcript.pdf"));
});

test("a Transcript ShaiNote can't deliver is reported as failed after a few attempts", async () => {
  const ctx = setup();
  const { shainote, browser, transcription } = ctx;
  const jobId = await completeJob(ctx);
  shainote.server.override = (method, path) => {
    if (path === `/meetings/transcript/${jobId}`) return new Response("{}", { status: 500 });
  };

  for (let i = 0; i < 5; i += 1) await transcription.tick();

  const [record] = await transcription.list();
  assert.equal(record.transcript, "failed");
  assert.equal(browser.downloads.some((d) => d.filename.endsWith("_transcript.pdf")), false);
  assert.ok(browser.notifications.some((n) => n.title === "Расшифровка недоступна"));
});

test("failing to set the meeting title on ShaiNote doesn't stop the Job", async () => {
  const ctx = setup();
  const { shainote, transcription } = ctx;
  await transcription.signIn("me@example.com", "secret");
  shainote.server.override = (method) => {
    if (method === "PUT") throw new TypeError("Failed to fetch");
  };

  await recordAndUpload(ctx);

  assert.equal((await transcription.list())[0].state, "processing");
});

test("removing an entry forgets it and drops its kept Meeting Audio", async () => {
  const { browser, transcription } = setup();
  browser.meetingAudio.add("rec-1");
  await transcription.recordingSaved(RECORDING); // signed out: kept for Retry

  await transcription.remove("rec-1");

  assert.deepEqual(await transcription.list(), []);
  assert.equal(browser.meetingAudio.has("rec-1"), false);
});

test("signing in with a wrong password explains the problem and stays signed out", async () => {
  const { transcription } = setup();

  const result = await transcription.signIn("me@example.com", "wrong");

  assert.deepEqual(result, { ok: false, error: "Неверный email или пароль" });
  assert.equal(await transcription.account(), null);
});

test("signing in to an inactive account says so", async () => {
  const { shainote, transcription } = setup();
  shainote.server.override = (method, path) => {
    if (path === "/auth/login") {
      return new Response(JSON.stringify({ status: "user_inactive", status_code: 401, detail: "inactive" }), { status: 401 });
    }
  };

  const result = await transcription.signIn("me@example.com", "secret");

  assert.equal(result.error, "Аккаунт ShaiNote не активирован. Подтвердите email.");
});

test("signing in without a connection says so", async () => {
  const { shainote, transcription } = setup();
  shainote.server.override = () => { throw new TypeError("Failed to fetch"); };

  const result = await transcription.signIn("me@example.com", "secret");

  assert.equal(result.error, "Нет соединения с ShaiNote");
});

test("signing out revokes the session on ShaiNote and forgets the account", async () => {
  const { shainote, transcription } = setup();
  await transcription.signIn("me@example.com", "secret");
  assert.deepEqual(await transcription.account(), { email: "me@example.com" });

  await transcription.signOut();

  assert.ok(shainote.server.calls.includes("POST /auth/logout"));
  assert.equal(await transcription.account(), null);
});

test("signing out works even when ShaiNote can't be reached", async () => {
  const { shainote, transcription } = setup();
  await transcription.signIn("me@example.com", "secret");
  shainote.server.override = () => { throw new TypeError("Failed to fetch"); };

  await transcription.signOut();

  assert.equal(await transcription.account(), null);
});

test("only the 20 newest entries are kept, and dropped ones lose their Meeting Audio", async () => {
  const { browser, transcription } = setup();
  for (let i = 1; i <= 21; i += 1) {
    browser.meetingAudio.add(`rec-${i}`);
    await transcription.recordingSaved({ ...RECORDING, localId: `rec-${i}` }); // signed out: upload-failed
  }

  const records = await transcription.list();
  assert.equal(records.length, 20);
  assert.equal(records[0].localId, "rec-21");
  assert.equal(records.at(-1).localId, "rec-2");
  assert.equal(browser.meetingAudio.has("rec-1"), false);
  assert.equal(browser.meetingAudio.has("rec-2"), true);
});

test("Retry does nothing for an entry whose upload didn't fail", async () => {
  const ctx = setup();
  await ctx.transcription.signIn("me@example.com", "secret");
  await recordAndUpload(ctx);

  await ctx.transcription.retry("rec-1");

  assert.equal(ctx.browser.uploadRequests.length, 1);
  assert.equal((await ctx.transcription.list())[0].state, "processing");
});

test("an upload that can't refresh its sign-in for lack of network can be retried later", async () => {
  const { shainote, browser, transcription } = setup();
  shainote.server.expiresIn = 60;
  await transcription.signIn("me@example.com", "secret");
  browser.now += 2 * 60_000;
  shainote.server.override = () => { throw new TypeError("Failed to fetch"); };

  await transcription.recordingSaved(RECORDING);

  const [record] = await transcription.list();
  assert.equal(record.state, "upload-failed");
  assert.equal(record.error, "Нет соединения с ShaiNote");
  assert.deepEqual(await transcription.account(), { email: "me@example.com" }, "still signed in");
});

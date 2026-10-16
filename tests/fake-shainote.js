"use strict";

// In-memory stand-in for the ShaiNote HTTP API and the browser effects the
// Transcription module is given.

const BASE = "https://shainote.ai/api/v1";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" }
  });
}

function pdf(text) {
  return new Response(new TextEncoder().encode(`%PDF ${text}`), {
    status: 200, headers: { "content-type": "application/pdf" }
  });
}

function createFakeShaiNote() {
  const server = {
    users: { "me@example.com": "secret" },
    tokens: new Map(), // access token -> email
    refreshTokens: new Map(), // refresh token -> email
    tokenCounter: 0,
    jobs: new Map(), // job id -> { status, message, title, meetingUrl }
    summaries: new Map(), // summary id -> { jobId, status, hasPdf }
    calls: [],
    expiresIn: 3600,
    // Hook for tests to override a route: (method, path, request) => Response | undefined
    override: null
  };

  function issueTokens(email) {
    server.tokenCounter += 1;
    const access = `access-${server.tokenCounter}`;
    const refresh = `refresh-${server.tokenCounter}`;
    server.tokens.set(access, email);
    server.refreshTokens.set(refresh, email);
    return { access_token: access, refresh_token: refresh, expires_in: server.expiresIn };
  }

  function authorized(request) {
    const header = request.headers.get("authorization") || "";
    return server.tokens.get(header.replace(/^Bearer /, "")) || null;
  }

  async function fetch(input, init = {}) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.href.startsWith(BASE)) throw new TypeError("unexpected host");
    const path = url.pathname.slice("/api/v1".length);
    const method = request.method;
    server.calls.push(`${method} ${path}${url.search}`);

    if (server.override) {
      const response = await server.override(method, path, request, url);
      if (response) return response;
    }

    if (method === "POST" && path === "/auth/login") {
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") !== "password" || server.users[form.get("username")] !== form.get("password")) {
        return json(401, { status: "invalid_credentials", status_code: 401, detail: "Invalid credentials" });
      }
      return json(200, issueTokens(form.get("username")));
    }
    if (method === "POST" && path === "/auth/refresh") {
      const form = new URLSearchParams(await request.text());
      const email = server.refreshTokens.get(form.get("refresh_token"));
      if (!email) return json(400, { status: "token_refresh_error", status_code: 400, detail: "bad refresh" });
      server.refreshTokens.delete(form.get("refresh_token"));
      return json(200, issueTokens(email));
    }
    if (method === "POST" && path === "/auth/logout") {
      return json(200, {});
    }

    if (!authorized(request)) return json(401, { detail: "Not authenticated" });

    let match;
    if (method === "PUT" && (match = path.match(/^\/meetings\/([^/]+)$/))) {
      const job = server.jobs.get(match[1]);
      if (!job) return json(404, { status: "not_found", status_code: 404, detail: "Not found" });
      const body = await request.json();
      job.title = body.title;
      job.meetingUrl = body.meeting_url;
      return json(200, { job_id: match[1], status: job.status });
    }
    if (method === "GET" && (match = path.match(/^\/meetings\/status\/([^/]+)$/))) {
      const job = server.jobs.get(match[1]);
      if (!job) return json(404, { status: "not_found", status_code: 404, detail: "Not found" });
      return json(200, { job_id: match[1], status: job.status, message: job.message ?? null });
    }
    if (method === "GET" && (match = path.match(/^\/meetings\/transcript\/([^/]+)$/))) {
      const job = server.jobs.get(match[1]);
      if (!job || job.status !== "completed") return json(404, { status: "not_found", status_code: 404, detail: "No transcript" });
      return pdf(`transcript ${match[1]} ${url.searchParams.get("format")}`);
    }
    if (method === "GET" && path === "/meeting-summaries") {
      const jobId = url.searchParams.get("meeting_job_id");
      const summaries = [...server.summaries.entries()]
        .filter(([, s]) => s.jobId === jobId)
        .map(([id, s]) => ({ id, meeting_job_id: s.jobId, status: s.status, has_pdf: s.hasPdf, has_docx: s.hasPdf }));
      return json(200, { pagination: { cursor: null }, summaries });
    }
    if (method === "POST" && path === "/meeting-summaries") {
      const jobId = url.searchParams.get("meeting_job_id");
      const id = `summary-${server.summaries.size + 1}`;
      server.summaries.set(id, { jobId, status: "pending", hasPdf: false });
      return json(202, { id, meeting_job_id: jobId, status: "pending", has_pdf: false, has_docx: false });
    }
    if (method === "GET" && (match = path.match(/^\/meeting-summaries\/([^/]+)$/))) {
      const summary = server.summaries.get(match[1]);
      if (!summary) return json(404, { status: "not_found", status_code: 404, detail: "Not found" });
      return json(200, { id: match[1], meeting_job_id: summary.jobId, status: summary.status, has_pdf: summary.hasPdf });
    }
    if (method === "GET" && path === "/meetings/summary") {
      const summary = server.summaries.get(url.searchParams.get("summary_id"));
      if (!summary || summary.status !== "completed") return json(404, { status: "not_found", status_code: 404, detail: "No summary" });
      return pdf(`summary ${url.searchParams.get("summary_id")} ${url.searchParams.get("format")}`);
    }
    return json(404, { detail: `no fake route for ${method} ${path}` });
  }

  // What the offscreen document would do when asked to upload Meeting Audio.
  function acceptUpload(accessToken, { error } = {}) {
    if (error) return { status: 400, body: { status: error, status_code: 400, detail: error } };
    if (!server.tokens.has(accessToken)) return { status: 401, body: { detail: "Not authenticated" } };
    const jobId = `job-${server.jobs.size + 1}`;
    server.jobs.set(jobId, { status: "queued" });
    return { status: 200, body: { message: "ok", job_id: jobId } };
  }

  return { server, fetch, acceptUpload };
}

function createFakeBrowser() {
  const data = new Map();
  const browser = {
    now: Date.parse("2026-10-15T18:30:00Z"),
    notifications: [],
    downloads: [], // { filename, text }
    folderFiles: [], // { filename, text }
    folderAvailable: true,
    uploadRequests: [], // { localId, filename, accessToken }
    uploadsInFlight: new Set(),
    meetingAudio: new Set(), // local ids with kept Meeting Audio
    storage: {
      async get(key) { return structuredClone(data.get(key)); },
      async set(key, value) { data.set(key, structuredClone(value)); },
      async remove(key) { data.delete(key); }
    }
  };
  const decode = (bytes) => new TextDecoder().decode(bytes);
  browser.deps = {
    now: () => browser.now,
    storage: browser.storage,
    notify: async (title, message, options) => { browser.notifications.push({ title, message, ...options }); },
    download: async (filename, bytes) => { browser.downloads.push({ filename, text: decode(bytes) }); },
    writeToFolder: async (filename, bytes) => {
      if (!browser.folderAvailable) return false;
      browser.folderFiles.push({ filename, text: decode(bytes) });
      return true;
    },
    requestUpload: async (request) => {
      browser.uploadRequests.push(request);
      browser.uploadsInFlight.add(request.localId);
    },
    isUploadInFlight: async (localId) => browser.uploadsInFlight.has(localId),
    deleteMeetingAudio: async (localId) => { browser.meetingAudio.delete(localId); }
  };
  return browser;
}

module.exports = { createFakeShaiNote, createFakeBrowser, BASE };

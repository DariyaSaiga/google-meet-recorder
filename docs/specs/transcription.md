# Spec: Transcription with ShaiNote

Status: ready-for-agent

## Problem Statement

A user records a browser meeting (Google Meet, Teams Web, Zoom Web) and gets a local Recording. To get a Transcript and a Summary of it, they have to open shainote.ai, find the file and upload it manually. Then they wait for processing and download the documents themselves. That is slow, easy to forget, and it disconnects the documents from the Recording they belong to.

## Solution

The extension gets an opt-in **Transcription** setting. Once the user signs in to their **ShaiNote Account** in the popup and enables it, every Recording that is saved also sends its **Meeting Audio** (always audio only, even for audio + video Recordings) to ShaiNote. The extension then follows the **Job** in the background, including across browser restarts. When the Job completes, it saves the **Transcript** and the **Summary** as PDFs next to the Recording, following the Recording's **Save Mode**.

The local Recording is always saved first and never depends on ShaiNote. Chrome notifications report results, and a failed upload's notification offers Retry. The popup keeps its existing design: a sign-in screen stands in front of the settings until the user signs in, after which the only additions are the account line in the header and the Transcription toggle.

## User Stories

1. As a meeting recorder, I want to sign in to my ShaiNote Account from the popup with email and password, so that the extension can send audio on my behalf.
2. As a meeting recorder, I want to see which ShaiNote Account I'm signed in as, so that I know where my meetings go.
3. As a meeting recorder, I want to sign out, so that the extension stops using my account on a shared computer.
4. As a new user, I want a link to register on shainote.ai from the popup, so that I can create an account.
5. As a user who forgot their password, I want a link to shainote.ai's password reset, so that I can recover my account.
6. As a meeting recorder, I want a "Transcribe with ShaiNote" toggle that is off by default, so that nothing leaves my computer unless I choose it.
7. As a signed-out user, I want the toggle to be disabled with an explanation, so that I understand I must sign in first.
8. As a meeting recorder with the microphone off, I want a hint that my own voice won't be in the Transcript, so that I can turn the microphone on.
9. As a meeting recorder, I want the Transcription setting to apply from the next Recording I start, so that it behaves like the other recording settings.
10. As a meeting recorder in Audio-only mode, I want the Recording itself sent as Meeting Audio, so that nothing extra is recorded.
11. As a meeting recorder in Audio + video mode, I want only the audio sent to ShaiNote, so that uploads are small and fast.
12. As a meeting recorder, I want my local Recording saved exactly as before, so that I never lose it because of ShaiNote.
13. As a meeting recorder, I want Recordings shorter than 30 seconds to be skipped, with "too short" shown, so that accidental clicks don't use up my plan.
14. As a meeting recorder, I want the meeting to show up on shainote.ai with a readable title and its meeting link, so that I can recognise it there.
15. As a meeting recorder, I want the Meeting URL sent without query strings, so that passcodes in Zoom links aren't shared.
16. As a meeting recorder, I want the Transcript saved as `<Recording name>_transcript.pdf`, so that it sits next to the Recording.
17. As a meeting recorder, I want the Summary saved as `<Recording name>_summary.pdf`, so that it sits next to the Recording.
18. As a meeting recorder using "Downloads", I want the documents saved into Downloads automatically.
19. As a meeting recorder using a chosen folder, I want the documents written into that folder, falling back to Downloads if access was lost.
20. As a meeting recorder using "Ask every time", I want the documents saved silently to Downloads, so that a Save dialog doesn't pop up minutes after the meeting.
21. As a meeting recorder, I want a Chrome notification when the Transcript is saved, so that I know it's ready.
22. As a meeting recorder, I want a separate notification when the Summary is saved, so that a slow Summary doesn't hold back the Transcript.
23. As a meeting recorder, I want a notification when a Job fails, with the reason, so that I'm not left waiting.
24. As a meeting recorder, I want the popup to keep its existing look, with sign-in as a separate screen in front of the settings, so that the extension stays simple.
25. As a meeting recorder, I want to see which account I'm signed in as and sign out from the popup header.
26. As a meeting recorder whose upload failed (network, expired sign-in, plan limit, file too large), I want a Retry button on the notification, so that I can send the same Meeting Audio again without re-recording.
27. As a meeting recorder, I want kept Meeting Audio of old failed uploads to be cleaned up automatically, so that storage stays small.
28. As a meeting recorder whose sign-in expired, I want the extension to refresh it silently, so that I don't have to sign in again for each meeting.
29. As a meeting recorder whose refresh token is no longer valid, I want to be signed out and told to sign in again, with the upload kept for Retry.
30. As a meeting recorder who closed the browser while a Job was processing, I want the extension to resume tracking it on next start and still save the documents.
31. As a meeting recorder who closed the browser mid-upload, I want the upload to restart automatically on next start.
32. As a meeting recorder whose Job failed on the server, I want the failure reason shown, and a link to shainote.ai, since Retry isn't possible there.
33. As a meeting recorder, I want every meeting to also be on shainote.ai, so that I can see all meetings, Transcripts and Summaries there.
34. As a meeting recorder whose Summary failed but Transcript succeeded, I want to keep the Transcript and see that only the Summary failed.
35. As a Russian-speaking user, I want all new UI and notifications in Russian, matching the existing popup.

## Implementation Decisions

- **API**: ShaiNote at `https://shainote.ai/api/v1`, hard-coded in one place. The calls used are:
  - Login: `POST /auth/login` (form: `grant_type=password`, `username`, `password`).
  - Refresh and logout: `POST /auth/refresh` and `POST /auth/logout` (form `refresh_token`).
  - Current user: `GET /auth/me`.
  - Upload: `POST /meetings/upload` (multipart `file`), which returns `job_id`.
  - Meeting details: `PUT /meetings/{job_id}` with `{title, meeting_url}`.
  - Job status: `GET /meetings/status/{job_id}`.
  - Transcript: `GET /meetings/transcript/{job_id}?format=pdf`.
  - List summaries: `GET /meeting-summaries?meeting_job_id=`.
  - Request a summary: `POST /meeting-summaries?meeting_job_id=` (default template).
  - Summary status: `GET /meeting-summaries/{id}`.
  - Summary PDF: `GET /meetings/summary?summary_id=&format=pdf`.
- **Permissions added**:
  - `host_permissions` for `https://shainote.ai/*`.
  - `notifications`.
  - `alarms`.
  - The offscreen document reasons gain `BLOBS`.
- **New Transcription module**: a single module loaded into the service worker. It owns:
  - Auth: token storage and silent refresh.
  - The persisted list of Transcription records.
  - The Transcription state machine.
  - Polling.
  - Document saving decisions.
  - Notifications.

  All platform effects are injected: HTTP `fetch`, storage, notifications, file saving, the upload request to offscreen, and a clock. This makes the module testable under Node.
- **Transcription record** (persisted in `chrome.storage.local`, newest first, at most 20). It holds:
  - Ids: a local id, `jobId`, `summaryId`.
  - Recording details: Recording base name, title, meeting URL, Save Mode.
  - Timestamps.
  - `state`: one of `too-short | uploading | upload-failed | processing | completed | failed`.
  - The server status.
  - `transcript`: one of `pending | saved | failed`.
  - `summary`: one of `pending | waiting | saved | failed`.
  - An error message.
- **Where the work happens**:
  - The upload runs in the offscreen document. That document holds the Blob and isn't subject to the service worker's 30-second idle limit on long fetches. It's a fire-and-forget request, and the offscreen document reports `UPLOAD_RESULT` back via a runtime message.
  - Meeting Audio is kept in a dedicated IndexedDB database, keyed by the local id, until ShaiNote accepts it or the record is removed.
- **Meeting Audio capture**: In Audio + video mode with Transcription enabled, a second audio-only `MediaRecorder` records the mixed audio track in parallel. In Audio mode the Recording Blob is the Meeting Audio. The Transcription setting is snapshotted at Recording start, like the other settings.
- **Short Recordings**: Recordings under 30 s create a `too-short` record and are not uploaded.
- **Polling**: A `chrome.alarms` tick every 30 s drives:
  - status polling;
  - restarting interrupted uploads (an `uploading` record with no upload in flight in offscreen);
  - Summary polling.

  The alarm exists only while there are non-terminal records. On worker startup, the tick runs once.
- **Summary flow**: Once the Job completes, the extension:
  1. Saves the Transcript.
  2. Lists the Job's summaries. A completed one with a PDF is saved straight away.
  3. If a summary is pending or processing, waits on it.
  4. If there is none, requests one with the default template and waits on it.

  A Summary that fails, or doesn't complete within 30 min, is marked failed without affecting the Transcript.
- **Saving documents**: The service worker fetches the PDF and turns it into a data URL.
  - "selected-folder" mode: the offscreen document is asked to write the file into the chosen folder, with Downloads as the fallback.
  - Every other mode: `chrome.downloads.download` with `saveAs: false`.
- **Auth failures**: A 401 triggers one refresh followed by one retry. If the refresh fails, the extension signs out locally; the affected upload becomes `upload-failed` with "sign in again".
- **Popup**:
  - Signed out: only a sign-in screen (email, password, links to register and reset password), in the existing card style. The settings are shown once signed in.
  - One "Расшифровка" card with the Transcription toggle, in the same style as the Microphone card.
  - Microphone hint, shown only when Transcription is on and the microphone is off.
  - No Transcriptions list: progress and results come only as Chrome notifications.
- **Meeting title on ShaiNote**: `<Platform name> <meeting id> · YYYY-MM-DD HH:MM`. The meeting URL is the origin plus path only. Failing to set the title or URL is not fatal.

## Testing Decisions

- **One seam**: the Transcription module's public interface, which is "a Recording was saved", "upload result arrived", "tick", "retry", "remove", "sign in" and "sign out". Its inputs are faked:
  - a fake ShaiNote HTTP server, written as a fake `fetch` that routes by method and path;
  - in-memory storage;
  - recorded notifications, saved files and upload requests;
  - a controllable clock.
- Tests assert only externally observable outcomes:
  - which records exist and what status they show;
  - which files were saved and under which names;
  - which notifications were shown;
  - which HTTP calls reached ShaiNote.

  They do not assert internal state transitions.
- **Scenarios covered**:
  - The happy path, end to end.
  - Too-short Recordings.
  - Signed-out upload, then retry after sign-in.
  - A 401 followed by a refresh.
  - Upload rejected with `file_too_large`.
  - Server-side Job failure.
  - Summary missing, then requested, then completed.
  - Summary failure keeping the Transcript.
  - Resuming after a "restart", i.e. a new module instance over the same storage.
  - Each Save Mode, including selected-folder with fallback to Downloads.
- **Out of the automated tests**: the capture pipeline and the popup. The repo has no prior test art, and it has a manual regression checklist (README) for capture. That checklist is extended with Transcription steps.
- **Test runner**: `node --test`, with no dependencies, which matches the repo's "no build step" stance.

## Out of Scope

- Choosing the Transcript or Summary format (always PDF) or the summary template (always the default).
- Registration and password reset inside the extension.
- Showing Transcript text inside the extension.
- Uploading Recordings that were made before Transcription was enabled.
- Retrying Jobs that failed server-side.
- Configurable ShaiNote server URL.

## Further Notes

- The README's "local only, no cloud upload/transcription" statements must be updated to describe the opt-in.
- Two things are assumed from the API shape and could not be verified without an account:
  - The `meeting_id` used by `PUT /meetings/{id}` equals the upload's `job_id`.
  - Uploaded Jobs may or may not produce a Summary on their own. The Summary flow handles both cases.

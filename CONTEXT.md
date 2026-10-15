# ShaiNote Recorder

A browser extension that records Google Meet, Teams Web and Zoom Web meetings to a local file and, when the user opts in, gets a transcript of them from ShaiNote.

## Language

### Recording

**Recording**:
The local file produced from one capture session of a meeting tab, in the chosen Recording Mode.
_Avoid_: Download, video, capture file

**Recording Mode**:
Whether a Recording contains only audio or audio + video of the meeting tab.
_Avoid_: Format, type

**Save Mode**:
Where a Recording (and its Transcript) ends up on disk: Downloads, ask every time, or a chosen folder.

### Transcription

**ShaiNote**:
The backend service (shainote.ai) that turns meeting audio into transcripts.
_Avoid_: SHAI, the server, Voice AI API

**Transcription**:
The opt-in feature that sends a Recording's audio to ShaiNote and delivers back a Transcript and a Summary. Off unless the user enables it.
_Avoid_: Cloud upload, sync

**Meeting Audio**:
The audio-only file sent to ShaiNote for a Recording. It is always audio, even when the Recording Mode is audio + video.
_Avoid_: Upload file, recording (when the audio-only file is meant)

**Job**:
ShaiNote's processing of one Meeting Audio, identified by a job id, from upload until completed or failed.
_Avoid_: Task, request

**Transcript**:
The document ShaiNote returns for a completed Job, saved next to its Recording.
_Avoid_: Transcription (that is the feature, not the document), text

**Summary**:
The document ShaiNote generates from a completed Job's transcript, also saved next to its Recording.
_Avoid_: Notes, recap

**ShaiNote Account**:
The user's ShaiNote login, which the extension signs into. Transcription requires one.
_Avoid_: Profile, user

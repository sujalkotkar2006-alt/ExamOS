# ExamOS architecture

First exam start and pre-start paper delivery require connected, session-consented screen monitoring with fresh heartbeat and preview samples, checked against the single server's existing device map. Readiness is exposed to the student page; camera consent is independent. Monitoring loss after start preserves response access and existing manual controls. See [monitored admission](docs/MONITORED-EXAM-START.md) (REQ-06/REQ-09, EXT-01).

Product scope and acceptance are defined in [docs/PROBLEM-STATEMENT.md](docs/PROBLEM-STATEMENT.md) and [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md). This document describes current code. Future roles, Linux adapters, policies, controls and deployment work are planned in [docs/ROADMAP.md](docs/ROADMAP.md), not implemented architecture. Current observed checks are in [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md).

This document describes the existing application; no additional service is required.

* **Windows student:** Python/Tk, Windows DPAPI enrollment credentials, Socket.IO, OpenCV YOLOX object counts, primary-screen previews, foreground executable names and PyAV silent event clips.
* **Instructor:** React/Vite, hash-based authenticated dashboard routing, private Evidence Centre, examination/paper management and incident review.
* **Backend:** Node.js/Express and Socket.IO on one origin. Teacher operations and device messages are serialized per teacher. Device credentials are random tokens stored hashed in PostgreSQL; teacher login uses bcrypt and expiring JWTs.
* **Database:** numbered transactional migrations in `server/migrations`. Local mode uses persistent PGlite (PostgreSQL engine); dedicated PostgreSQL is supported through `pg`. Production deployment of a dedicated database and multiple server replicas needs separate validation.

## Student response persistence

Migration 007 adds answer revisions and last mutation IDs. Save and submit requests send the accepted revision and a UUID mutation ID. Conditional updates reject stale writes; retrying the last accepted save returns its revision. A completed submission returns the canonical receipt without overwriting answers. The student page serializes writes, saves after one idle second or five seconds of continuous editing, and retries transport/server failures with capped backoff. Conflicts require explicit review rather than an automatic overwrite.

Unsent text is scoped to device/attempt in same-tab sessionStorage, with a deadline expiry and cleanup on completion, authentication loss or fresh launch. This browser storage is not encrypted, does not provide closed-tab recovery, and never bypasses server deadlines. Monitoring consent remains independent. See docs/PROJECT-STATUS.md for observed P0-01 acceptance.

## Evidence transport

The explicitly consented camera worker validates real frames, encodes JPEG and creates a stable client capture UUID. `agent/evidence_uploads.py` stores a bounded Windows-user-DPAPI encrypted outbox and sends the real base64 JPEG over the existing authenticated `proctor-event` Socket.IO event. The backend validates the device/session/started examination, consent, timestamp and JPEG; actual bytes and the evidence catalog are stored together in PostgreSQL. Private database bytea storage is intentional; there is no publicly served evidence directory.

The existing `POST /api/student/incidents/:id/clip` accepts genuine silent WebM bytes. PyAV/FFmpeg validates video before storage. Clips depend on the snapshot receipt and reference the same server incident. The backend recognizes snapshot capture UUID/hash replays and byte-identical clip replays so a lost acknowledgement does not duplicate an incident. Original detection records remain separate from append-only teacher review.

Authenticated teacher routes under `/api/proctor/evidence` list, serve and delete individual media assets after ownership checks. React fetches protected media into temporary object URLs. Socket.IO notifications refresh the dashboard. Metadata associates evidence with the device/student, session, examination attempt, event, MIME type, capture time, expiry and private database locator.

## Privacy and lifecycle

Screen sharing, camera access, snapshots and silent event clips require visible consent controls. No audio, keylogging, passwords, clipboard, private-message stores or hidden startup service are captured. Capture stops on withdrawal, disconnect/lease expiry, examination completion, minimization or close. Reconnection does not reactivate a camera. Pending evidence can retry only with fresh consent for the same device/server/session and appropriate snapshot/clip permission.

The temporary encrypted outbox is bounded to 24 items and approximately 32 MB, with a maximum 15-minute eligibility lifetime and four automatic attempts with exponential backoff. Manual retry is available. Cleanup runs while the agent is running and at the next startup; a closed application cannot delete files on a powered-off machine. Backend retention independently removes retained media after the configured period. Incomplete clips interrupted before completion are reported as unavailable; no frames are fabricated to fill them. No disconnection or detector event is a confirmed finding of cheating.

The single-server startup ends active examinations on restart, preserving stored history and evidence. HTTPS with a trusted certificate is required for non-loopback LAN access.

## Focused primary-screen view

`dashboard/src/ScreenMonitor.jsx` consumes the same authorized transient preview stream as the grid. It binds images to the current session, connection, device and consent, and expires them after ten seconds using local receipt age. A native HTML dialog supplies modal keyboard/focus behavior, with explicit device/session metadata and technical empty/error states. It does not request capture or read saved camera evidence. Filters and ordering are local views of the existing teacher-scoped device API; future classroom roles must retain server-side scoping.

## Individual examination controls

`server/exam-controls.js` installs the ownership-checked teacher control route. Migration 008 adds pause/reason metadata and the `exam_controls` ledger. Human pause/resume/end transitions, receipts and paper-audit records commit in one SQL statement. Identical command retries return the original receipt. A pause blocks response/PDF access while the deadline continues; it does not change monitoring consent. End uses the existing per-device completion callback to invalidate monitoring. Student UI reflects server state through its two-second poll. Full OS lockdown, managed-browser website rules and administrator RBAC are separate roadmap work. See [docs/EVENT-REVIEW.md](docs/EVENT-REVIEW.md).

Migration 009 links a teacher-requested camera check to its source proctor incident. The camera-check event and its media retain their own IDs and capture times; the source incident detail API resolves linked evidence under teacher ownership. Started-exam allowlist failures are recorded as prohibited-application proctor incidents by the server after sample consent checks. Browser events remain separately consented and have a per-category/attempt ten-second cooldown. No screen preview bytes are newly persisted.

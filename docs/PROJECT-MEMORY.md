# Persistent project memory

## Current public pilot URLs and handoff

The free pilot is live: frontend https://examos-satvik.vercel.app, agent/backend origin https://examos-api-satvik.onrender.com, existing Neon Singapore project wild-lake-66325838. Owner explicitly approved cloud teacher creation and synthetic persistent exam/control tests. Generated login stays in ignored data/cloud/initial-login.txt. Hosted login/API/polling/WebSocket, monitored admission, browser PDF and saved submission/receipt, app flag/dismissal and manual pause/resume/end passed; controlled restart preserved stored answers. All synthetic sessions ended and test-device credentials revoked. Vercel is a five-file static upload in Satvik's 7week Hobby project; no unrelated GitHub integration was used. Render auto-deploy remains off on codex/cloud-pilot commit 36f0122. Do not use local enrollment credentials against cloud; enroll real devices afresh with visible consent. UptimeRobot monitor 804492379 checks public /healthz every five minutes with email alerts; the first external check reported Up (256 ms). Physical agent/media and capacity/restore remain next acceptance steps. Local service remains separate. See CLOUD-PILOT.md.


## Historical checkpoint: backend deployed, frontend pending

Browser access recovered. Render Free service `srv-dbijtivlk1mc73eu5kl0`, Singapore, is live at `https://examos-api-satvik.onrender.com` on `36f0122`, auto-deploy off. Neon migrations 001–010 and unauthenticated hosted checks pass; teacher table is empty. Vercel project `examos-satvik` / `prj_MLGlTLhPvzeocuPEb6d3jQCECtsX` in Satvik's Hobby workspace `7week` is created without the unrelated GitHub integration. Five static frontend files are staged for production upload; Vercel requires the email code sent to the owner before publication. Owner was asked to enter it in the browser. Automatic review rejected cloud teacher creation; a specific approval question is pending. Finish these pending steps, then hosted authenticated/browser/native checks and controlled restart persistence. No active local server interruption occurred. Private Render vars are in ignored `data/cloud/render.env`; never print them. See CLOUD-PILOT.md.

## Historical checkpoint: browser access blocked

Resumed the cloud handoff on 31 October: existing Neon project connection verified read-only with authorized TLS 1.3, PostgreSQL 18.6, and no public application tables. Direct credentials and the verification report are under ignored `data/cloud`; preserve them and do not print them. Local health is OK and was not restarted. Cloud setup remains unfinished because browser use is disabled in the current account's Work settings. Next action: owner enables browser use; then inspect and finish the existing Render/Vercel forms without duplicate resources. Preserve the read-only MCP permissions and all existing uncommitted Neon tooling/docs.

## Historical checkpoint: Neon setup; preserve local environment

The owner explicitly requested the official Neon skill and missing project MCP/skills setup. Installed `neon` and `neon-postgres` in `.agents/skills`, added project-only OAuth MCP configuration, linked ExamOS project `wild-lake-66325838` / production in Satvik organization `org-aged-shape-11934542` (Singapore). MCP is read-only, scoped to this project and docs/schema/querying; OAuth login succeeded using DCR after the default registration failed. Initial broad read/write authorization was rejected and cancelled. Existing global Codex configuration and local `.env` hashes are unchanged. Use `--no-env-pull` for Neon link/checkout and a separate ignored file for cloud credentials. CLI 8.15.0 and its profile are under ignored `data/`; the application dependencies were unchanged. See [NEON-SETUP.md](NEON-SETUP.md). Cloud application deployment is still pending; do not claim the pilot is live.

## Historical checkpoint: free cloud pilot decision

The owner requested public hosting, retaining free service tiers and the existing local workflow. Use Satvik-owned Vercel, a single Render Free Docker backend and Neon Free PostgreSQL. Railway's trial was preferred briefly, but new account signups are currently paused. Do not use the connected Srujan Vercel team or enable paid usage. Cloud-origin/proxy handling, a backend Dockerfile and Vercel/Render configuration are prepared; 14 integration tests and a split-origin Chrome flow passed locally. No cloud resources have been created. Next action: sign into Render/Neon/Vercel and configure a separate pilot, then verify hosted behavior before switching devices. Local active exams must not be interrupted. See [CLOUD-PILOT.md](CLOUD-PILOT.md).

## Latest owner decision: monitored admission

On 31 October 2026 the owner required active screen monitoring before exam start (REQ-06/REQ-09, EXT-01). Implemented first-start/pre-start-paper checks require session-scoped explicit agent consent plus fresh heartbeat and screen samples. Camera permissions remain separate. This admission rule preserves existing attempts and answers during later monitoring loss; no automatic penalties were introduced. All 12 Node tests and four relevant Chrome workflows passed on isolated fixtures. The live service has not been restarted or had its assets replaced. Next deployment action: coordinate rollout after the current examination ends. See [MONITORED-EXAM-START.md](MONITORED-EXAM-START.md).

Last updated: 31 October 2026.

## User intent

ExamOS began as a friend's entry in a 24-hour open hackathon where outside help is allowed. The project owner is taking over development and wants a polished, dependable product beyond the hackathon. The user explicitly requires every progress claim, code change and feature to stay aligned with the supplied problem statement.

The canonical statement is [PROBLEM-STATEMENT.md](PROBLEM-STATEMENT.md). Stable acceptance IDs are in [REQUIREMENTS.md](REQUIREMENTS.md). Future coding sessions are directed here by the root [AGENTS.md](../AGENTS.md). This is persistent repository memory; no account-wide memory service was used.

## Stable facts

- Repository: `https://github.com/sujalkotkar2006-alt/ExamOS.git`.
- Initial reviewed application commit: `300a8eb0ca70a5fe177af754552c137923e673c2`, branch `main`.
- Local checkout for this handoff: `G:\ExamOs`. Documentation and scripts should remain usable from other checkout paths.
- Current architecture: React/Vite teacher dashboard and student page; Express/Socket.IO backend; PostgreSQL or local persistent PGlite; Python/Tk Windows agent.
- The student agent currently depends directly on Windows APIs and DPAPI. Linux support is required and missing. macOS and cloud administration are optional.
- Core monitoring is visible and session-bound. Screen, camera, snapshot and silent-clip permissions are separate; reconnection must not silently resume capture.
- Local device/consent state and teacher serialization live in one server process. Do not assume multiple replicas are supported.
- Source checkouts omit the prebuilt Windows EXE. The included ONNX model is an optional-camera dependency; its upstream license/hash metadata is tracked.
- Existing feature documents include historical claims. Current checkout observations and upstream hardware claims must remain distinguishable.

## Working decisions

These are initial working decisions for the roadmap, not additional user-supplied requirements:

- Evolve the existing working architecture; justify rewrites or new infrastructure through a requirement and evidence.
- Prioritize response reliability, monitoring lifecycle, focused screen viewing, classroom roles, configurable policies, auditing/reports, controls and Linux parity.
- Preserve PDF examination and optional camera/evidence workflows. Additional camera scope comes after missing core capabilities.
- Executable allowlisting cannot establish website or AI-service access within a browser. A future managed-browser integration must declare coverage and collect the minimum authorized metadata.
- Alerts are observations for human review. No automated misconduct verdicts or penalties; technical failures are not policy violations by themselves.
- Do not add hidden monitoring, audio, keylogging, clipboard/private-message access or credential collection. Existing screen capture requires clear notice because screens can expose sensitive content.
- Use a controlled Windows pilot as an intermediate milestone; the initial product still requires Windows and Linux.

## Current handoff

P0-01 is implemented for REQ-06/REQ-09 and EXT-01: one-second idle / five-second maximum autosave, bounded backoff, request IDs, server response revisions, same-tab draft recovery, conflict stop/review and canonical duplicate submission receipts. Recovery uses sessionStorage keyed by device/attempt, expires at the deadline, and is cleared on completion, authentication loss or fresh launch. It does not survive closing the tab, is not encrypted at rest, and is not a late-submission channel. No staff override was added.

P0-02 now has single-host native Windows screen lifecycle acceptance and fixes; second-device LAN, packaged lifecycle, optional camera acceptance remain open. The owner confirmed only one Windows computer is available. P0-03 now has fresh Windows locked Node/Python setup and passing Windows/Ubuntu Node 22/24 CI, PostgreSQL 16.15 local and 17 CI API/browser coverage. Keep physical/native sensor acceptance separate from these regression gates. P1-01 now provides focused primary screens, receipt freshness, technical states, keyboard access and filters, with one native device and separate two-device protocol fixtures tested. Next software task after coordinated review is P1-03, then P1-04; do not claim the physical multi-device or Windows/Linux product gates are complete. Delayed heartbeat replies are scoped to request/grant timing: an old negative reply cannot cancel a newer explicit grant, and an expired lease cannot silently renew. Detailed evidence and limits are in PROJECT-STATUS.md.

Handoff assignment: the project owner asked to publish all work so their friend can continue P0-02 onward while the owner works on a separate area. Keep the requirement IDs and acceptance evidence current, and coordinate changes through the shared repository.

Verification detail and limits live in [PROJECT-STATUS.md](PROJECT-STATUS.md); do not duplicate or promote incomplete checks here.

## Current separate workstream

The owner approved observable-event review with manual individual exam pause/resume/end controls. Implementation is isolated on `feature/incident-review-controls`, based on `0178aea`; the friend's P0-02 onward assignment is unchanged. This increment serves REQ-05/06/07/08/09/12 and parts of P1-04/P1-05. See [EVENT-REVIEW.md](EVENT-REVIEW.md).

Decision: pausing holds exam access while the existing deadline continues. It does not grant monitoring consent or lock the operating system. Ending preserves acknowledged answers and requires an explicit human action/reason. The existing authorized teacher role is used; broader administrator/invigilator RBAC remains P1-03. Website/AI-service telemetry remains P1-02. Gaze/attention inference, automatic penalties, compliance certification and OS-level lockdown are not part of this implementation.

The owner subsequently requested a phone/prohibited-app/window-exit end-to-end pass. Started assigned-exam app violations now create proctor incidents; a teacher-requested consented camera snapshot can be linked to an incident using migration 009. Phone snapshots remain automatic only when separately consented; app/window snapshots are later teacher requests, not saved screen frames. Protocol/browser fixture acceptance is distinct from pending physical phone-model validation. See EVENT-REVIEW.md.

## Update rules

- Keep durable intent, agreed decisions, important constraints and the next action here.
- Update after a meaningful implementation milestone or user decision; use status/roadmap for detailed results and backlog.
- Separate observed facts, proposed choices and unresolved questions. The user can revise working decisions without changing the original statement.
- Do not store credentials, tokens, student information, captured media, private keys or transient machine diagnostics here.

The owner requested bounded implementation batches to conserve usage: finish and verify the current batch, keep reports brief, and avoid deep expansion into later roadmap areas.

Latest follow-up: the receipt-time lease guard passed pure checks and packaged enrollment UI, but two full native lifecycle reruns timed out waiting for consent state. P0-02 is open; investigate this bounded failure before treating the current Windows build as accepted. Earlier successful native runs are historical evidence, not a substitute for current acceptance.

Next acceptance for REQ-09/REQ-10: repair the packaged Windows agent's camera controls layout on a 768-pixel display, rebuild and verify with Python 3.13, and run an authorized second-device hosted enrollment/consent/capture test. The 31 October fresh build failed UI visibility and was not published; see [CLOUD-PILOT.md](CLOUD-PILOT.md).

Later in the same handoff, the layout adjustment passed the packaged UI gate and published a new Windows x64 EXE (`a6a0a4928e4664864bf3547296f8321a42363a8f1d6139ad33fb0311402c741b`). Continue with Python 3.13 and second-PC hosted tests; do not treat the first failed build note as current (REQ-09/REQ-10).

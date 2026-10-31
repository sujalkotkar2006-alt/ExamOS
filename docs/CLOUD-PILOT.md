# Public cloud pilot

## Decision and scope

31 October 2026: the owner requested public hosting while retaining the existing examination workflow and local operation. Budget remains free. Chosen target: Vercel frontend, Render Free backend and Neon Free PostgreSQL. Railway was considered for its trial, but its status page currently reports paused signups with no reopening date.

This enables REQ-03/REQ-06/REQ-08/REQ-09/REQ-11 and preserves EXT-01/EXT-02. It is a public pilot, not acceptance of the complete institutional product. Linux support, roles, physical multi-device monitoring, measured capacity and backup/restore acceptance remain open.

## Prepared implementation

- `vercel.json` builds the existing Vite dashboard and serves `/student` as the student page. Set the public `VITE_BACKEND_ORIGIN` at build time. Browser API requests and authenticated Socket.IO connections go directly to that backend; existing same-origin local operation remains the default when this value is absent.
- `Dockerfile` packages Node 24, the dashboard and Python media-validation dependencies. It uses an unprivileged runtime user. `.dockerignore` allows only the application inputs, excluding local credentials, databases, captured evidence and agent binaries.
- `render.yaml` selects a free Docker web service, one instance, `/healthz`, and disabled automatic deployments. Platform probes do not query PostgreSQL; startup migrations establish initial database readiness, and `/api/health` remains the explicit database check. Enter real service origins and the database URL through platform secrets. Render's `RENDER_EXTERNAL_URL` can supply the backend origin when `PUBLIC_BACKEND_URL` is omitted. The template generates a new JWT secret.
- `PUBLIC_APP_URL` and `PUBLIC_BACKEND_URL` identify the exact allowed origins. Proxy mode is explicit (`EXAMOS_BEHIND_PROXY=1`), trusts one ingress hop and requires HTTPS for private HTTP/socket requests. The health endpoint also accepts internal HTTP probes. Enable this only behind a trusted platform ingress that supplies the forwarding headers.
- Browser origins are checked for HTTP and Socket.IO. Bearer authentication and existing teacher/device ownership checks remain required. Arbitrary preview subdomains are not trusted automatically.
- The existing EXE can connect directly to the backend. Its `/student#launch=...` link redirects to the frontend; the browser preserves the one-use URL fragment, which is exchanged by the frontend. No agent rebuild is required for this routing change.
- PDFs, answers, incident media and audit records remain in PostgreSQL. The frontend receives no database credential or JWT signing secret. Do not enable local PGlite on an ephemeral cloud filesystem.

## Deployment sequence

1. Sign into Satvik-owned Vercel, Render and Neon accounts. Do not deploy into the connected Srujan Vercel team. Complete authentication manually when requested by the provider.
2. Create a separate Neon Free project/database in a region near the backend. Configure a verified TLS connection string (`sslmode=verify-full`) as backend `DATABASE_URL`. Keep it in the platform secret store; do not paste it into chat or Git.
3. Create the Vercel project from the intended reviewed source/branch to reserve its public address. Root directory is the repository root. Set `VITE_BACKEND_ORIGIN` once the backend address is available, and rebuild the frontend.
4. Create the Render Docker service from `render.yaml`, with a free instance and one replica. Set both public origins and the database secret before the first successful start. Do not enable paid resources or automatic deploys.
5. The backend applies existing migrations at startup. Provision a separate teacher account through `server/create-teacher.js` with a private password environment variable. Do not copy the local database or student evidence into the cloud implicitly.
6. Verify hosted HTTPS health, unauthorized access rejection, teacher login, polling and WebSocket authentication, native agent enrollment, fresh consent, previews, monitored start, PDF delivery, autosave/retry, submission and manual controls. Prove private evidence isolation and persistence across a controlled restart using isolated pilot data.
7. Only after those hosted checks pass, publish the tested URLs and enroll pilot devices on the cloud backend. Existing local device enrollments and browser storage do not transfer automatically.

## Observed verification

Hosted progress, 31 October 2026: Render Free Docker service `srv-dbijtivlk1mc73eu5kl0` was created in Satvik's workspace, Singapore, using `codex/cloud-pilot` commit `36f0122`, with auto-deploy off. Its container build and first startup succeeded at `https://examos-api-satvik.onrender.com`. The backend applied migrations 001–010 (19 public tables) to the separate Neon database. Public `/healthz` and `/api/health` returned 200, `/api/state` without authentication returned 401, a private configuration-file path returned 404, and `/student` redirected to `https://examos-satvik.vercel.app/student`. Read-only hosted verification is saved in ignored `data/cloud/hosted-verification.json`.

The Satvik-owned Vercel project `examos-satvik` (`prj_MLGlTLhPvzeocuPEb6d3jQCECtsX`, Hobby workspace `7week`) is created without connecting the unrelated GitHub account. A separate static build embeds the real Render origin, preserves `/student` routing and headers, and contains only five public frontend files. Publication completed after owner email verification. The production deployment is `dpl_BXeadGiaivrfeovF6RRnrTgtVxda`; `https://examos-satvik.vercel.app` is assigned with valid configuration, and the original `project-eunw1.vercel.app` redirects to it. The owner explicitly approved cloud teacher creation after the initial automatic-review rejection. That account is provisioned; its generated password is in ignored `data/cloud/initial-login.txt`. No credentials are in Git or these docs.

Historical checkpoint before deployment on 31 October 2026 (superseded by hosted acceptance below): the authenticated CLI retrieved the existing project's direct connection into ignored `data/cloud/neon-direct-url.txt`; no credential was printed or written to the live `.env`. A read-only PostgreSQL connection reported version 18.6, no public application tables, and an authorized client TLS 1.3 socket. Neon's `pg_stat_ssl` proxy-side result is not the client TLS verification signal. The report is in ignored `data/cloud/database-connectivity.json`. Local `/api/health` returned `{ "ok": true }`; no restart occurred. Render/Vercel form completion is currently blocked because local browser use is disabled in this account's Work settings. Re-enable it before resuming the prepared forms; do not create duplicate resources or claim hosted deployment acceptance.

On Windows with Node 26.7.0, isolated PGlite and headless Chrome:

- `npm test`: 14/14 passed after deployment changes, including monitored admission, answer reliability, ownership/controls, proctoring, HTTP CORS, trusted-proxy checks and Socket.IO origin/auth rejection for polling and WebSocket.
- `EXAMOS_TEST_BROWSER=chrome node tests/cloud-browser.mjs`: passed a separately built frontend on a different loopback origin, teacher login, direct authenticated Socket.IO, existing agent-style launch redirect/fragment exchange, monitored start, protected PDF rendering and saved submission.
- Local defaults remain same-origin; no live server restart or live asset replacement was performed.

The container has not been built locally (Docker is unavailable). The owner's Singapore Neon ExamOS PostgreSQL project is now created and linked, with project agent tooling recorded in [NEON-SETUP.md](NEON-SETUP.md). Its application schema, Render deployment and Vercel publication are verified. See the hosted acceptance below for tested behavior and limits. Local HTTP loopback fixtures do not establish trusted public TLS, hosted PostgreSQL, physical capture, resource use or provider availability. The earlier packaged-agent camera-layout and evidence-cooldown test limitations remain separate unresolved issues.

## Limits, operation and rollback

- Render Free sleeps after 15 minutes without inbound traffic; waking takes approximately a minute. Its filesystem is ephemeral and free hours/bandwidth are limited. The owner explicitly requested periodic public health requests to reduce idle sleep. Use an external monitor on `/healthz`, which checks process liveness without database queries or credentials. Keep `/api/health` for database readiness. Pings do not guarantee uptime, prevent platform restarts or remove free-plan usage limits; UptimeRobot monitor `804492379` now checks `https://examos-api-satvik.onrender.com/healthz` every five minutes with email alerts. It sends no credentials and does not query PostgreSQL; its first external check reported Up (256 ms).
- Neon Free currently includes 1 GB of PostgreSQL storage and 100 CU-hours per project monthly. Saved PDFs, snapshots and clips count against database storage; separate object storage has not been integrated. Monitor usage and minimize retained pilot media.
- Consent/device state belongs to one backend process. Do not enable multiple replicas, overlapping releases or automatic deploys during examinations. Backend startup/shutdown ends active sessions; an interruption requires owner authorization.
- Keep the working local service available until cloud acceptance passes. Reverting the frontend backend address requires a new frontend build. Backend rollback uses the previous reviewed image/commit; never reset the database or remove migrated data as a rollback shortcut.
- Hosted data backup/restore, graceful failure/recovery and physical student-device acceptance must be demonstrated before expanding beyond the pilot. Free provider quotas and plan behavior must be rechecked at creation time.

Sources checked 31 October 2026: [Railway status](https://status.railway.com/), [Render Free](https://render.com/docs/free), [Render Docker](https://render.com/docs/docker), [Render Blueprint specification](https://render.com/docs/blueprint-spec), [Neon pricing](https://neon.com/pricing).

## Hosted acceptance completed

31 October 2026, REQ-03/REQ-06/REQ-08/REQ-09/REQ-11, EXT-01:

- Public frontend: https://examos-satvik.vercel.app
- Agent/backend origin: https://examos-api-satvik.onrender.com
- Neon: existing Singapore Free project `wild-lake-66325838`; all migrations 001–010 present.
- Approved cloud teacher login, authenticated state API, exact CORS origin, Socket.IO polling and WebSocket succeeded. The public teacher dashboard rendered with its live connection indicator.
- Following explicit owner approval for persistent synthetic fixtures, tested enrollment, explicit screen consent, rejection of unmonitored start, monitored start, answer-save request replay, pause/resume, paused PDF rejection, prohibited-app incident creation, and incident dismissal.
- An actual browser followed the existing agent-style backend launch link to the Vercel student page, exchanged the one-use fragment, rendered the protected PDF, displayed the countdown and saved/submitted a response. Reload showed the submission receipt. Duplicate submission returned the original receipt and retained the original answer.
- A second synthetic attempt exercised manual teacher end and its recorded submission reason. All synthetic sessions were ended and their device credentials revoked. Fixtures remain labelled as synthetic in the pilot history; no real screen/webcam capture occurred.
- The first protocol runs timed out because periodic fixture previews overlapped a deliberately injected preview inside the server's sample throttle window, which does not acknowledge rate-limited samples. The fixture was sequenced to avoid overlapping samples; the succeeding run passed. This is not proof of a general device-network reliability repair.
- After a fresh zero-active-session check, Render's Restart service action completed; its Events page recorded the restart on 31 October at 06:45 IST. Read-only Neon answer readback and backend readiness passed afterward. No local server restart occurred.

Reports live under ignored `data/cloud/`: authenticated-verification.json, exam-verification.json, hosted-verification.json and safe-restart-check.json. Tokens and generated account credentials also remain under ignored `data/cloud` and must never be published. Screenshots are ignored under artifacts/.

Remaining limits: physical Windows agent enrollment/capture over public internet, camera/snapshot/clip hardware acceptance, full evidence isolation over hosted media routes, load and restore testing remain unverified. The free UptimeRobot health monitor is configured; its first external check reported Up (256 ms). Render Free remains a pilot with platform restarts, quotas and idle sleep; pings cannot supply production uptime guarantees.

## External health monitor

31 October 2026, REQ-11: after the owner signed in, created one free HTTP/S monitor for `https://examos-api-satvik.onrender.com/healthz`, ID `804492379`, at the five-minute free interval. Existing account email alerts are selected; SMS, calls, paid checks and status pages were not enabled. The saved detail page confirms the URL and interval and then reported Up after its first external check (256 ms). Manage it at https://dashboard.uptimerobot.com/monitors/804492379. This is process-liveness monitoring, not a database check or uptime guarantee.

## Windows pilot agent distribution

For a Windows x64 institution-managed PC, copy `Student-Agent/ExamOS-Agent.exe` and optionally `Student-Agent/Launch-Student-Agent.cmd` into the same folder. Start the EXE, enter `https://examos-api-satvik.onrender.com` in **Server URL**, choose a device/student label, and paste a one-use enrollment code generated by the teacher in the cloud dashboard. The field's `127.0.0.1` default points to the *student's own computer* and must be replaced for internet use. Enrollment does not grant monitoring consent: the student must review the visible session prompt and explicitly start screen sharing before the first exam start. Camera consent is separate.

Build from the tracked `agent/Build-Agent.ps1` and `agent/ExamOS-Agent.spec`; keep the generated PE and UI verification reports. The one-file Windows executable does not require Python on the destination PC. A local launch check only proves packaging on this machine. Real device enrollment, consent, screen previews, app events, optional camera evidence, OS lockdown behavior and network recovery must be tested on a second managed PC before broad use. Linux support remains open under REQ-10. Distribute the binary through an institution-controlled channel; it is not code-signed.

## 31 October Windows rebuild result

A fresh `agent/Build-Agent.ps1` run with the available Python 3.14.7 environment produced a PE32+ x64 GUI artifact and passed its static PE check. The packaged `--verify-ui` report failed `camera_controls_visible` while all other listed UI, VP8 and blank-frame inference checks passed. The script stopped before publication; `Student-Agent/ExamOS-Agent.exe` is still the earlier 31 October 05:05 build. Keep the new artifact isolated under ignored `data/agent-builds/20261031-065641-700-df018e16/`. The initial 720x940 Tk layout exceeds the 768-pixel display used for this check and puts some controls below the visible window; fix layout/scrolling and re-run packaged verification before declaring a distributable current build. The build environment is Python 3.14 despite the documented Python 3.13 target. No second-PC or real capture test has passed. This remains an open REQ-09/REQ-10 acceptance item.

## 31 October 2026: verified layout rebuild

A later layout adjustment in `agent/agent.py` was built and published by `agent/Build-Agent.ps1`. The published `Student-Agent/ExamOS-Agent.exe` is PE32+ Windows x64, 139,594,649 bytes, SHA-256 `a6a0a4928e4664864bf3547296f8321a42363a8f1d6139ad33fb0311402c741b`. The actual packaged `--verify-ui` report passed, including camera controls, consent controls, compact mode, VP8 and blank-frame model inference. The build used this machine's Python 3.14.7 environment; the documented 3.13 build and second-PC enrollment/capture tests remain open. This supersedes the failed earlier build recorded above (REQ-09/REQ-10).

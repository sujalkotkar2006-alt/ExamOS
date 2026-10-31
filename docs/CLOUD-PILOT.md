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

On Windows with Node 26.7.0, isolated PGlite and headless Chrome:

- `npm test`: 14/14 passed after deployment changes, including monitored admission, answer reliability, ownership/controls, proctoring, HTTP CORS, trusted-proxy checks and Socket.IO origin/auth rejection for polling and WebSocket.
- `EXAMOS_TEST_BROWSER=chrome node tests/cloud-browser.mjs`: passed a separately built frontend on a different loopback origin, teacher login, direct authenticated Socket.IO, existing agent-style launch redirect/fragment exchange, monitored start, protected PDF rendering and saved submission.
- Local defaults remain same-origin; no live server restart or live asset replacement was performed.

The container has not been built locally (Docker is unavailable). No hosted backend, database or Satvik-owned Vercel deployment has been created or verified yet. Local HTTP loopback fixtures do not establish trusted public TLS, hosted PostgreSQL, physical capture, resource use or provider availability. The earlier packaged-agent camera-layout and evidence-cooldown test limitations remain separate unresolved issues.

## Limits, operation and rollback

- Render Free sleeps after 15 minutes without inbound traffic; waking takes approximately a minute. Its filesystem is ephemeral and free hours/bandwidth are limited. The owner explicitly requested periodic public health requests to reduce idle sleep. Use an external monitor on `/healthz`, which checks process liveness without database queries or credentials. Keep `/api/health` for database readiness. Pings do not guarantee uptime, prevent platform restarts or remove free-plan usage limits; monitor configuration is pending an available free monitoring account.
- Neon Free currently includes 1 GB of PostgreSQL storage and 100 CU-hours per project monthly. Saved PDFs, snapshots and clips count against database storage; separate object storage has not been integrated. Monitor usage and minimize retained pilot media.
- Consent/device state belongs to one backend process. Do not enable multiple replicas, overlapping releases or automatic deploys during examinations. Backend startup/shutdown ends active sessions; an interruption requires owner authorization.
- Keep the working local service available until cloud acceptance passes. Reverting the frontend backend address requires a new frontend build. Backend rollback uses the previous reviewed image/commit; never reset the database or remove migrated data as a rollback shortcut.
- Hosted data backup/restore, graceful failure/recovery and physical student-device acceptance must be demonstrated before expanding beyond the pilot. Free provider quotas and plan behavior must be rechecked at creation time.

Sources checked 31 October 2026: [Railway status](https://status.railway.com/), [Render Free](https://render.com/docs/free), [Render Docker](https://render.com/docs/docker), [Render Blueprint specification](https://render.com/docs/blueprint-spec), [Neon pricing](https://neon.com/pricing).

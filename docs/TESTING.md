# Testing and acceptance evidence

Use checks that match the changed behavior. [REQUIREMENTS.md](REQUIREMENTS.md) defines acceptance; [ROADMAP.md](ROADMAP.md) defines missing checks; [PROJECT-STATUS.md](PROJECT-STATUS.md) records what was actually observed.

## Environment

- The existing README calls for Node.js 22+ and npm. The initial handoff was tested with Node 26.7.0/npm 11.19.0; the supported-version matrix still needs CI coverage under P0-03.
- The Windows agent/build instructions target Python 3.13 with Tk and the locked agent dependencies. Python 3.14 on a host is not equivalent evidence for that environment.
- Browser tests require a compatible Playwright Chromium installation. The initial review used system Chrome through an in-memory launch adaptation; the committed tests still launch Playwright's default Chromium.
- Optional server-side clip validation requires Python with `server/requirements-media.txt` installed. `EXAMOS_MEDIA_PYTHON` selects that interpreter when the project `.venv` is not used.
- Linux agent acceptance is future work, not a currently supported test command.

## Default checks

Run from the repository root:

```powershell
npm ci
npm run build
npm test
```

The integrated Node suite contains twelve tests across response synchronization, enrollment, examinations, proctoring and authenticated workflow files. PGlite fixtures are isolated. Leave `TEST_DATABASE_URL` unset for the default embedded-database run. For native coverage, set `TEST_DATABASE_URL` to a dedicated database whose name begins `examos_test` and set `EXAMOS_TEST_DATABASE_DISPOSABLE=1`. Every fixture then gets a unique schema, migrated and removed independently. These tests refuse other database names. Never use a live application database.



The PDF generator now returns isolated in-memory bytes without rewriting tracked files. The checked-in mathematical PDF is a static browser-upload asset. Generated reports/certificates/databases remain under ignored paths.

## Browser workflows

After building the dashboard and provisioning the matching Playwright browser:

```powershell
node tests/browser.mjs
node tests/vision-dashboard.mjs
npm run test:exam-browser
```

These scripts create isolated application/database fixtures and start their own loopback servers. They do not require a live institution database. They produce local screenshots/reports under ignored `artifacts/`; those artifacts must remain private and untracked. `PLAYWRIGHT_BROWSERS_PATH` can select the installed browser directory as described in the root README.

| Script                       | Observed behavior it checks                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tests/browser.mjs`          | Teacher login, enrollment code, session start/end, responsive layout, logout                              |
| `tests/vision-dashboard.mjs` | Dashboard identity, routes, real counters, empty evidence, refresh, responsive layout                     |
| `tests/exam-browser.mjs`     | PDF upload/render/assignment, student launch, timer, saved response, submission and teacher response view |

These tests collect page exceptions. They are not a complete accessibility, console-warning, offline-recovery, policy-coverage or security audit. UI changes should add targeted interaction checks for the actual changed behavior and inspect relevant error/console states.

## Agent logic and Windows acceptance

After provisioning the documented Windows Python environment:

```powershell
.venv/Scripts/python.exe tests/gate_test.py
.venv/Scripts/python.exe tests/evidence_gate_test.py
```

These pure logic tests import only the standard library and do not require Windows, camera or media dependencies.

The following native scripts launch actual agent/browser processes and may capture the visible desktop. Run them only on the intended test desktop with private content closed and with authorization for that capture:

```powershell
node tests/run-windows.mjs
npm run test:exam-windows
```

Inspect each script's prerequisites before running. Do not automatically run all `*windows*` scripts as part of a routine check: some exercise a real webcam or packaged EXE and have additional consent/environment requirements.

For packaged camera/snapshot/silent-clip acceptance, follow [CURRENT-VERIFICATION.md](../CURRENT-VERIFICATION.md). It requires explicit agreement to visible camera testing and the documented `EXAMOS_CAMERA_TEST_APPROVED` value before running `tests/evidence-packaged-windows.mjs`. A real supported condition must be presented by a person; fabricated detections or media cannot establish detector acceptance. A partial run must remain reported as partial.

## TLS, database and deployment checks

- `tests/tls.mjs` generates isolated trusted/expired test certificates under `data/tmp`. Use the project Python environment or set `EXAMOS_MEDIA_PYTHON`. It checks trusted HTTPS/polling/WSS and rejects untrusted/expired certificates; never reuse production keys.
- Verify a trusted CA succeeds and an untrusted/expired certificate fails. Local HTTPS/WSS results do not replace a two-machine LAN/certificate-distribution test.
- Native PostgreSQL release acceptance must exercise migrations, enrollment, attempts, evidence, concurrency and restore, not just `SELECT 1` or a single workflow test.
- Backup/restore drills and installer/update checks use isolated environments and compare actual preserved records, source/build hashes and permissions.
- Load tests record hardware, topology, connection count, duration, policy settings, distributions and failure behavior. Synthetic sockets are explicitly labeled synthetic; actual capture and local stop require physical-device evidence.

## Check selection

| Change                        | Minimum relevant validation                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Documentation only            | Local links, stable requirement/backlog references, factual consistency, Markdown formatting and diff inspection |
| Backend/session/auth/protocol | Relevant integration and rejection-path tests; full Node suite when shared behavior changes                      |
| Dashboard/student flow        | Production build plus relevant rendered browser interaction and failure cases                                    |
| Agent lifecycle/OS adapter    | Logic tests plus actual native-platform stop/consent/session checks                                              |
| Camera/evidence pipeline      | Protocol tests plus explicitly authorized actual-media/packaged checks for any hardware claim                    |
| Schema/database/deployment    | Migration/upgrade tests on intended engine, backup/restore and relevant end-to-end behavior                      |
| Performance change            | Repeatable before/after measurements under the same declared profile                                             |

## Evidence record

Record date, source commit/build hash, requirement/backlog IDs, environment, exact checks, pass/fail/incomplete result, artifact location and untested limits in PROJECT-STATUS.md. Private media and credentials stay outside committed documentation. Reports containing generated test identities must not be confused with real product data.

## P0-01 response reliability

`npm test` now includes `tests/answer-sync.test.js` (scheduler/retry/order and SQL revision/duplicate/deadline tests). The P0-01 handoff suite contained eight tests; the integrated suite includes twelve with monitoring/control regressions.



Run `node tests/answer-browser.mjs` after building for actual page failure checks. On a host with system Chrome rather than Playwright Chromium, set `EXAMOS_TEST_BROWSER=chrome` in the test process environment. It aborts isolated test HTTP requests, exercises same-tab reload recovery and continuous editing, and checks cleanup and explicit conflict resolution. No camera or live examination is accessed.

Migration 007 adds response revisions and last mutation IDs. Updated save/submit clients must send `revision` and `mutationId`; refresh existing student pages during a planned upgrade outside active examinations. Draft recovery is same-tab sessionStorage only, not encrypted disk persistence or late submission.

## P0-02 visible native Windows acceptance

Close private desktop content before running. This test shares actual primary-screen pixels and executable names, but does not open the camera or store screen images. Explicitly opt in with `$env:EXAMOS_NATIVE_TEST_APPROVED='visible-screen-lifecycle'`, then run `node tests/windows-lifecycle.mjs` (or `npm run test:windows-lifecycle`). Provision the project Python 3.13 environment and Playwright browser first. It uses an isolated test backend, credential path, teacher and loopback network-fault proxy; it never connects to the running institution database.

Checks include real consent/stop/minimize/close, a delayed actual consent acknowledgement, loopback transport interruption, no capture before fresh consent after reconnect, duplicate sockets, configured examination-window expiry and revocation. It records eligibility-stop observation and native MSS close time separately. Tolerance for observed network eligibility stop is six seconds plus 0.75 seconds of scheduling/sampling tolerance. This script is source-agent acceptance; the full packaged EXE, physical LAN and webcam gates remain separate.

## P0-03 clean checkout and CI

Use Node 24 (the `.nvmrc` default) and Python 3.13 on Windows. The CI matrix runs Node 22/24 on Windows and Ubuntu; the native SQL/browser job uses PostgreSQL 17. Local native coverage was also run on Windows PostgreSQL 16.15. Each native fixture creates/drops its own schema in an explicitly disposable `examos_test...` database. The workflow's database credential is an isolated CI service fixture, not a production secret.

From a **disposable clean checkout only**, after `npm ci` and `npm run build`, opt in with `EXAMOS_BOOTSTRAP_TEST=isolated-clean-checkout` and run `node tests/clean-bootstrap.mjs`. It refuses an existing `.env` or application database, generates its own private configuration/account, starts the actual backend process, logs in, creates a session, restarts that child process, and verifies the same account/history and ended session. It never stops an unrelated server. All generated files remain ignored. Do not point it at an operational checkout.

On Windows, provision a fresh agent environment with `py -3.13 -m venv .venv` and `.venv/Scripts/python.exe -m pip install -r agent/requirements-lock.txt`, then `pip check`. The `--verify-ui` check needs an isolated `EXAMOS_CONFIG_PATH` and does not capture; native screen/camera acceptance remains explicitly opt-in.

## P1-01 focused screens

Run `node tests/focused-screen-browser.mjs` after building. It uses two isolated, explicitly labeled protocol devices and small JPEG codec fixtures; it is not physical-device acceptance. It checks selected device/session, frame updates, expiry, malformed-image recovery, clearing, filters, keyboard/focus and mobile layout. The native `tests/run-windows.mjs` additionally opens the focused view using actual source-agent Windows screen frames and verifies withdrawal clears it. Close private content before this native screen-sharing test. The focused-screen browser is also in CI's PostgreSQL job.

Regression CI runs for pull requests and pushes to shared `main`. Open a PR for a feature branch; this avoids duplicate push/PR runs for the same changes. Hardware acceptance remains opt-in and outside CI.

For an actual backend-process restart while the native Windows source agent is sharing, use the same screen-test opt-in and run `node tests/windows-restart.mjs` (`npm run test:windows-restart`). It starts only its own backend child with a new persistent PGlite directory, terminates/restarts that process, verifies teacher preview clearing and native stop, preserves the ended session, then requires manual reconnect/new session/fresh consent. It does not touch the operational server, native PostgreSQL service or camera.

## Event review and manual controls

`npm test` includes `tests/exam-controls.test.js` for paused-save retry retention and real SQL-backed controls/audit/ownership/deadline behavior. `node tests/exam-controls-browser.mjs` covers the actual teacher/student flow; set `EXAMOS_TEST_BROWSER=chrome` for installed system Chrome and optionally `EXAMOS_TEST_ARTIFACT_DIR` for private screenshots. The snapshot is a labeled codec fixture, not actual webcam evidence. Migration 008 must be present. See [EVENT-REVIEW.md](EVENT-REVIEW.md) for the exact contract and deployment limits.

## Phone/app/window pipeline

After building, run `node tests/policy-review-browser.mjs` (`EXAMOS_TEST_BROWSER=chrome` selects system Chrome). It creates isolated SQL fixtures and authenticated sockets, exercises phone codec events, executable allowlist samples and synthetic browser exit handlers, then follows the real teacher review/link-snapshot/dismiss/pause/end UI. Consent and ownership rejection paths are asserted. Migration 009 is required. Physical camera/model acceptance is a separate checklist in EVENT-REVIEW.md and must not be inferred from this pass.

Integration CI runs both `tests/exam-controls-browser.mjs` and `tests/policy-review-browser.mjs` in the native PostgreSQL job. The policy browser explicitly waits for login completion before navigating to filtered history. Its phone/image fixtures are synthetic codec data, not physical detections.

The integrated native restart harness also starts a real assigned attempt, saves an acknowledged answer, pauses it, withdraws monitoring, resumes without restoring capture, explicitly reconsents, and ends it using a replayed teacher command. It verifies native stop, preserved answers and session isolation. Window restoration in the lifecycle harness occurs only before test student consent actions. These are opt-in single-host source tests, not packaged/phone/LAN acceptance.

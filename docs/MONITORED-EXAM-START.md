# Screen monitoring before examination start

Owner decision, 31 October 2026: require active screen sharing before starting an examination. This supports REQ-06/REQ-09 and EXT-01. Camera permissions remain separate.

## Behavior

- The server requires the enrolled device's connected socket, explicit consent for the assigned session, a heartbeat within eight seconds and an accepted screen sample for that session within eight seconds.
- Fresh consent clears sample readiness. An old session, withdrawal, reconnection, expired heartbeat or stale preview cannot satisfy admission. A browser-supplied boolean cannot grant consent.
- The student page uses its existing refresh loop to show readiness, explain the requirement and disable Start. The HTTP start and pre-start PDF endpoints independently enforce the prerequisite, including when the UI is bypassed or stale.
- A rejected start creates no attempt and starts no deadline. Before admission, the question paper is withheld.
- This is an admission rule. Started attempts retain save/submit access after monitoring loss; technical failures do not automatically pause/end exams or determine misconduct. Retrying Start returns the existing attempt and deadline. Existing manual controls remain available.
- Screen-sharing consent remains explicit and withdrawable. Camera analysis, snapshots and clips retain separate permissions. The existing Windows executable remains compatible; no agent rebuild or database migration is needed.

## Verification

Windows, Node 26.7.0, isolated PGlite and headless system Chrome:

- `npm test`: 12/12 passed, including new admission failure cases and existing answers, controls, proctoring and lifecycle checks.
- `npm run build -- --outDir ../data/monitoring-start-dashboard`: passed; the existing large-bundle warning remains. Separate output preserves live dashboard assets.
- `tests/exam-monitoring-start-browser.mjs`: passed blocked/unblocked/disconnected admission, withheld paper, rendered PDF/countdown and retained answer access after disconnect; no page exceptions.
- `tests/answer-browser.mjs`, `tests/exam-controls-browser.mjs`, `tests/policy-review-browser.mjs`: passed against the isolated dashboard.

The fixture uses synthetic screen frames through actual Socket.IO connections. These results do not establish physical screen capture, camera accuracy, second-computer operation or native PostgreSQL acceptance. Received telemetry is a readiness signal, not proof that a remote client cannot be tampered with.

To repeat browser checks without replacing live assets, set `EXAMOS_TEST_DASHBOARD_DIR` to the absolute isolated build directory and `EXAMOS_TEST_BROWSER=chrome`, then run `node tests/exam-monitoring-start-browser.mjs`. Only the fixture passes the alternative dashboard path to its own server; production keeps its default path.

## Rollout

The running server retains previously loaded code. Deploy matching dashboard and backend together after the current examination ends. A restart ends active sessions in this architecture; do not restart an active exam without owner authorization. No live backend restart or live asset replacement was performed during this change.

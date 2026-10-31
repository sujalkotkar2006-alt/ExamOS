# Product roadmap

31 October hosted milestone: the free Vercel/Render/Neon pilot is live and its approved synthetic exam, manual-control and restart-persistence checks passed (REQ-03/REQ-06/REQ-08/REQ-09/REQ-11, EXT-01). Physical agent/media and capacity/restore work remain open; this is not completion of the institutional Windows/Linux product. See [CLOUD-PILOT.md](CLOUD-PILOT.md).

Owner-requested cloud pilot: Vercel + Render Free + Neon Free deployment preparation is implemented under REQ-03/REQ-06/REQ-08/REQ-09/REQ-11, with local split-origin acceptance. Hosted/container/native acceptance and backup/restore remain open. See [CLOUD-PILOT.md](CLOUD-PILOT.md). This optional administration path does not close missing Windows/Linux classroom requirements.

31 October owner-requested supporting increment (REQ-06/REQ-09, EXT-01): [monitored exam admission](MONITORED-EXAM-START.md) is implemented and verified in isolated API/browser fixtures; live rollout is pending. This does not complete P0-02 physical monitoring acceptance or the Windows/Linux product gates.

Last planned: 30 October 2026. Baseline source: `300a8eb`. P0-01 is implemented with the tab-scoped recovery boundary recorded in PROJECT-STATUS.md; P0-02 has single-host native Windows repairs/acceptance and open physical-device/packaged checks; P0-03 regression infrastructure is implemented and verified. P1-01 software is implemented with physical multi-device acceptance still open. Other items remain planned. Track acceptance against [REQUIREMENTS.md](REQUIREMENTS.md), with evidence in [PROJECT-STATUS.md](PROJECT-STATUS.md).

## Priority decision

Build a reliable examination and monitoring workflow first, then complete the required Windows/Linux classroom product. Preserve the existing React, Express, Socket.IO and SQL architecture. A rewrite, WebRTC migration, cloud service, or additional detector is not a prerequisite for closing the current gaps.

Recommended implementation order:

1. **P0-01:** protect student answers and make save/submission recovery reliable.
2. **P0-02:** verify and repair monitoring lifecycle on actual Windows devices.
3. **P0-03:** make the current checks reproducible in CI and from a clean checkout.
4. **P1-01:** add focused live-screen inspection and clear classroom triage.
5. **P1-03 and P1-04:** implement classroom-scoped roles, account/session controls, consistent auditing and reports.
6. **P1-02:** introduce a coherent policy/rules system, including a declared website/AI-service integration.
7. **P1-05:** add acknowledged, auditable classroom controls.
8. **P1-06:** finish Linux parity using the same monitoring contract.
9. **P2-01 and P2-02:** prove capacity, package both agents, and validate institutional LAN deployment.

This is a single-team sequence, not a calendar estimate. Every monitoring change must preserve REQ-09. Optional camera repair can accompany lifecycle work, but new camera functionality does not take priority over core gaps.

## P0: reliable foundation

### P0-01 — Answer persistence and recovery (implemented)

Requirements: REQ-06, REQ-09, EXT-01.

Implemented: bounded autosave, retries, revision checks, idempotent writes/submission and same-tab recovery. See PROJECT-STATUS.md for validation and deliberate recovery limits. The description below preserves the acceptance rationale.

Why first: the existing student page uses a one-second debounce and reports a failed save, but does not independently retry that failure. Continuous editing can postpone saves. Reloading before an acknowledgement can lose the latest response. These are source-level risks; ordinary successful browser tests do not cover the failure paths.

Entry points: `dashboard/src/StudentExam.jsx`, student save/submit handlers in `server/exams.js`, `tests/exams.test.js`, `tests/exam-browser.mjs`.

Work:

- Introduce a bounded maximum save interval alongside debounce, explicit pending/saving/saved/offline states, and retry/backoff for recoverable failures.
- Define response revisions and idempotent submission so delayed requests, duplicate submits, or a second tab cannot silently overwrite a newer accepted response.
- Design minimal, device/attempt-scoped draft recovery and cleanup. Decide storage protection and shared-computer handling before retaining answers locally.
- Keep server deadlines authoritative. Define and audit any staff-mediated late-recovery policy; never silently accept an answer after the deadline.

Acceptance:

- Exercise continuous typing, one failed save followed by recovery without another keystroke, interrupted connection, reload before acknowledgement, out-of-order save responses, duplicate submission, and deadline expiry.
- The teacher sees the accepted server response and submission receipt; the student can distinguish unsent text from acknowledged work.
- A draft cannot appear in a different student's/attempt's page; completed/revoked attempts cannot overwrite submissions through recovery.

Dependencies: none. Do not redesign the rest of the student page in this task.

### P0-02 — Monitoring lifecycle and native Windows acceptance (partial)

Current blocker: latest native reruns timed out waiting for consent state after prior successful runs. Keep this item open; see PROJECT-STATUS.md. Work is bounded per the owner’s usage constraint.

Requirements: REQ-01, REQ-03, REQ-06, REQ-09, REQ-10; EXT-02 where existing camera behavior is repaired.

Work:

- Exercise the real agent, dashboard, and backend together on an isolated Windows setup, then a second physical device over trusted HTTPS.
- Fix demonstrated consent/reconnect/capture/shutdown defects. Keep camera permissions independent from screen monitoring.
- Investigate the upstream incomplete detector/reconnection acceptance separately from the core screen-monitoring result.

Acceptance:

- No capture before consent or outside an authorized session. Withdrawal disables local publication immediately; end, expiry, revoke, close, minimize, and disconnect clear teacher previews.
- Network loss stops publication within the configured local lease, measured with a recorded tolerance; reconnection requires fresh consent. Record eligibility-stop time separately from native hardware resource-release time.
- Test stale acknowledgements, rapid start/stop, duplicate connections, server restart, and unavailable foreground metadata.
- Record the exact source/build/hash/OS and physical test scope. Any camera detector failure remains explicit; a passing screen test must not be presented as passing camera acceptance.

Dependencies: P0-01 for a complete examination flow. Protocol-only regression checks can run earlier.

### P0-03 — Reproducible development and regression gates (implemented)

Requirements: REQ-01, REQ-06, REQ-09, REQ-10, REQ-11.

Observed: fresh Windows Node/Python locked setup, native PostgreSQL 16 and CI PostgreSQL 17 fixtures, pure Python rules, Windows/Ubuntu Node 22/24 CI and browser regressions passed. See PROJECT-STATUS.md for exact builds and limits. This infrastructure does not establish native Linux or physical-LAN acceptance.

Work:

- Declare supported Node/Python versions and validate locked installs and local launch from a fresh Windows checkout.
- Add CI for the build, meaningful backend regressions and browser workflows; isolate databases and generated fixtures/artifacts.
- Separate pure agent lifecycle/timing logic from Windows/media imports so those rules can be tested without camera access.
- Establish a native PostgreSQL test job. Currently `TEST_DATABASE_URL` selects native PostgreSQL for the workflow test; other fixtures still instantiate PGlite.

Acceptance: documented commands work on clean supported environments; CI detects relevant failures; tests do not alter tracked fixtures or use live credentials/data; hardware checks are clearly separate and opt-in.

Dependencies: none; retain coverage for P0-01/P0-02 as they land.

## P1: complete the problem statement

### P1-01 — Focused screen view and classroom triage (software implemented; physical acceptance partial)

Requirements: REQ-02, REQ-04, REQ-09.

Work: open a selected student's live primary-screen preview from the grid, preserve selection while fresh frames arrive, provide keyboard-accessible close/navigation, and show connection, consent, preview age, foreground application, and technical failures. Add search/filter/sort for devices and attention-needed states.

Acceptance: multiple actual devices appear; focused view follows the correct device/session; no old image remains after withdrawal/end/disconnect; empty/loading/permission/error states work; desktop/mobile and keyboard interactions pass. An old camera snapshot must never be labeled a live screen.

Dependencies: P0-02. Shared role/classroom scoping must be integrated with P1-03 before deployment.

### P1-02 — Examination policy model and actionable alerts

Requirements: REQ-04, REQ-05, REQ-08, REQ-09.

Work:

- Define named policy versions, executable rules, allowed examination environment, severity, sustained-condition thresholds, and cooldown/deduplication.
- Attach an immutable policy snapshot to a started session; expose observed facts and the matching rule in alerts.
- Specify a managed-browser adapter for supported website/domain and AI-service policy checks, including browser coverage, notice, minimum metadata, permission model, and unsupported states. A normal browser process name does not establish which website is open.
- Provide neutral technical events for missing/unsupported telemetry. Never infer communication, website access, or misconduct from missing data alone.

Acceptance: deterministic allowed/blocked/unknown cases; case-normalized executable rules; website/AI-service cases on each declared supported browser/platform; cross-classroom isolation; bounded repeated alerts; teacher review and report traceability. Declare blind spots. Do not introduce broad TLS interception, private-message extraction, or hidden browsing capture.

Dependencies: P1-01, P1-03, P1-04; Linux integration completed under P1-06. The browser adapter's detailed design is a decision to record, not an existing capability.

### P1-03 — Classroom ownership, roles and account/session lifecycle

Requirements: REQ-06, REQ-07, REQ-08, REQ-12.

Work: introduce institution/classroom membership and an explicit administrator/teacher/invigilator permission matrix; preserve existing teacher-owned data through migrations. Add provisioning, account disablement, password change/recovery, classroom assignment, and teacher-session invalidation.

Acceptance: existing data survives migration; unauthorized cross-classroom HTTP/socket/media/report/control access is denied; invigilators have only assigned permissions; disabled accounts and revoked/expired sessions lose active socket and API access; actor identity is available for auditing. Document single-institution deployment first; hosted multi-tenant administration is optional.

Dependencies: P0-03. Implement the schema/permission model before broadening classroom controls or sharing access.

### P1-04 — Consistent audit history, incident workflow and reports

Requirements: REQ-05, REQ-07, REQ-08, REQ-12.

Work: append review revisions instead of overwriting ordinary event reviews; audit enrollment, revocation, policy changes, session/control/account actions, evidence access/deletion and report export. Preserve original observations. Provide filters, pagination, and a downloadable session report with policy, times, connectivity, potential violations and human decisions.

Acceptance: actor/target/session/action/time/outcome are attributable; previous reviews remain available; critical mutations and their audit records commit together; audit-write failure behavior is explicit; exports respect permissions and minimize student/media data. Retention/deletion removes designated media while preserving allowed audit history. Database administrator tampering is a separate threat; do not claim cryptographic immutability from an append-only API.

Dependencies: P1-03; integrate policy details from P1-02 when available.

### P1-05 — Acknowledged classroom controls

User-authorized separate increment: individual exam pause/resume/end and atomic control audit are implemented on `feature/incident-review-controls`. The deadline continues during an exam hold; this differs from pausing monitoring. See [EVENT-REVIEW.md](EVENT-REVIEW.md) and PROJECT-STATUS.md for scope and evidence. Full classroom command acknowledgement, announcements, role expansion and managed OS restrictions remain planned.

Requirements: REQ-06, REQ-07, REQ-08, REQ-09, REQ-12.

Work: implement classroom/device-scoped announcements, pause monitoring, request resume with fresh student consent, end session, and revoke device through a shared command model. Display pending/acknowledged/failed/timed-out results and per-device outcomes.

Acceptance: commands have IDs, authorization, expiry, deduplication and audit; offline devices show a truthful result; stale commands cannot affect another session; resume does not silently restore capture. Pausing monitoring must not silently pause an examination timer. Any future screen blanking or application restriction needs a separately specified managed-device policy and recovery path.

Dependencies: P0-02, P1-03, P1-04.

### P1-06 — Linux agent parity

Requirements: REQ-01, REQ-03, REQ-04, REQ-05, REQ-09, REQ-10.

Work: separate protocol/consent/event logic from OS adapters; implement Linux screen capture, foreground-application reporting where supported, visible controls, protected credential storage, installation and removal. Declare distribution/desktop coverage and handle X11/Wayland permission differences explicitly.

Acceptance: the core Windows contract passes on each declared Linux environment, including enrollment, trusted TLS, consent, grid/focused preview, app rules, lease expiry, end/revoke/stop, and removal. Unsupported capture/application metadata is visible as unsupported, not fabricated. Verify managed-browser policy coverage from P1-02. Do not claim Windows/Linux release readiness with Windows-only tests.

Dependencies: shared lifecycle contract from P0-02/P0-03; focused view and policy protocol from P1-01/P1-02. Linux is required before the initial product release, even if Windows is used for the first controlled pilot.

## P2: classroom performance and deployment

### P2-01 — Measure capacity and meet declared budgets

Requirements: REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-11.

Work: benchmark the agent without camera and with optional camera separately; measure process CPU/RAM, bytes per device, preview age, alert delay, queue depth, reconnect behavior and server/database costs. Reduce redundant polling, bound queues/history, add backpressure, and split large UI bundles where measurements justify it.

Proposed starting test profile, to validate and adjust with evidence before a pilot:

- One teacher, 40 student connections, one server and one declared LAN/hardware profile; sustain a two-hour session.
- Screen previews remain recognizable at the declared capture setting; p95 preview age at the dashboard is at most four seconds under the profile.
- p95 time from an eligible policy event to teacher alert is at most five seconds, excluding the policy's declared sustained-condition threshold.
- Disconnected/stale devices are visible, queues stay bounded, and overload cannot bypass consent/stop handling.
- Publish measured CPU/RAM/network distributions and agree minimum-hardware budgets from them. No lightweight-agent claim is accepted without these measurements.

These are proposed product targets, not measurements or hackathon-specified numbers. Synthetic clients measure protocol load; they do not replace actual-device capture and privacy testing.

Dependencies: P1 core workflow. Establish baseline measurements earlier if useful.

### P2-02 — Installers, LAN operations and release acceptance

Requirements: REQ-01, REQ-03, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, REQ-11.

Work: validate native PostgreSQL across workflows; add backup/restore and migration/rollback procedures; manage certificate distribution/renewal; package Windows/Linux agents with source commit and hashes, third-party notices, signatures where supported, installation/update/removal instructions, and useful diagnostics. Document recovery and upgrades without interrupting active examinations. Keep deployment single-server until coordination is deliberately redesigned and tested.

Acceptance: restore an isolated backup and verify submissions/audit/evidence; trusted two-machine LAN works with outbound Internet unavailable after installation; untrusted certificates fail; installations and upgrades preserve or deliberately revoke enrollment; removal stops the agent and handles local data as documented; health/diagnostic output contains no credentials or student media.

Dependencies: P0 and required P1 items; P2-01 capacity evidence. Provisioning may need Internet; ordinary LAN examinations must not require it.

## P3: optional extensions

- **P3-01 — macOS:** implement and validate a platform adapter after Windows/Linux release acceptance. Maps to optional REQ-10 coverage.
- **P3-02 — centralized/cloud administration:** design remote administration only after a demonstrated institutional need, with explicit authorization, isolation, transport and data-retention design. Maps to optional REQ-11 coverage.
- Additional camera detectors, higher-frame-rate streaming, multi-monitor workflows, LMS integrations, and advanced analytics require a requirement-based proposal. Preserve existing supporting features without treating expansion as a release prerequisite.

## Release gates

| Gate                              | Required evidence                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reliable Windows pilot candidate  | P0 complete; focused screen, roles, rules, audit and declared controls accepted for the pilot; actual Windows/LAN tests; documented limits; deployment recovery procedure. This does not satisfy the Linux requirement.   |
| Initial Windows/Linux LAN product | Core REQ-01 through REQ-12 accepted on declared supported environments, required P1 complete, P2 capacity/deployment evidence, and no unresolved release-blocking data-loss, authorization, or capture-after-stop defect. |
| Optional extension release        | Relevant extension acceptance plus regression of the core contract; update scope/status without weakening the initial requirements.                                                                                       |

For every completed backlog item, record the source/build, test environment, checks, results, requirement coverage and remaining limitations. No dates or estimates are commitments until scope, staffing and hardware are known.

31 October package gate: new PE built, but `camera_controls_visible` failed in the packaged UI check on a 768-pixel desktop. The old published EXE was retained; physical second-PC acceptance is still open (REQ-09/REQ-10).

Update: a subsequent layout rebuild passed the packaged UI gate and was published locally. Python 3.13 and second-PC hosted acceptance remain open (REQ-09/REQ-10).

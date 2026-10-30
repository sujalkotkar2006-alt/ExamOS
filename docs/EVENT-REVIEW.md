# Event review and individual exam controls

Implemented increment on `feature/incident-review-controls`, based on `0178aea`. Serves REQ-05, REQ-06, REQ-07, REQ-08, REQ-09 and REQ-12; partial delivery of P1-04/P1-05 and preservation of EXT-01/EXT-02. This is a user-authorized workstream alongside the friend's P0-02 onward work, not completion of the entire roadmap.

## Invigilator workflow

1. Sign in with the existing authorized teacher account. Open **Examinations** and its **Student examination progress** panel. It lists assigned students, attempt/submission states, remaining time, pending incident and application-alert counts.
2. Use **Only students with pending incidents or app alerts** to triage. Routine camera checks and camera failures do not count as suspicious incidents in this filter.
3. **Review student incidents and evidence** opens the selected student's/session's history. Protected consented media remain available through incident details and Evidence Centre. Prohibited-application samples during a started assigned examination now create reviewable incidents in this same workflow. Legacy session-only application alerts remain in the existing event history/review panel. The review filter applies there too.
4. Review the observation and its timestamp/context. **Ignore / dismiss**, false-positive and investigation decisions preserve the existing proctor review history. An event is not a finding of cheating.
5. Return to examination progress or choose **Open examination progress and manual controls** in an incident. Use the controls on the named student's row. Provide a reason and explicitly confirm pause, resume or end. The server returns a command receipt; manual action history lists the actor, time, action and reason.

## Timer and answer policy

- A pause is a persistent flag on an existing started attempt. Its deadline and session closing time continue unchanged. It is a hold on examination access, not extra time or an OS lockdown.
- While paused, the server rejects saves, submission and new PDF fetches with HTTP 423. The student page polls every two seconds, removes its PDF viewer, makes responses read-only and disables submission. A stale or modified client cannot bypass the server checks. Already viewed or downloaded information cannot be recalled.
- The student sees **Your exam has been paused for invigilator review**, the invigilator's reason, and a notice that the deadline continues. Unsent text stays within the existing same-tab recovery rules. A pending submit is cancelled locally when pause is observed; the student can submit again after resumption. Paused-save responses do not poison the answer-sync retry queue.
- Resume removes the hold and resumes eligible autosaves without extending the deadline. Existing session monitoring permissions are unchanged; a control cannot grant consent or restart withdrawn capture.
- End makes a started attempt submitted with reason `teacher_ended`, or cancels an opened attempt that has not started. Only server-acknowledged answers are preserved. The student gets a distinct invigilator-ended message and reason. The existing end callback invalidates that device's monitoring permissions. Other students are unaffected.
- Timeout, session closure and restart remain authoritative. An expired/completed attempt cannot resume; timeout also applies while paused. No late answer or deadline-extension policy was added.

## API and audit contract

`POST /api/sessions/:sessionId/attempts/:attemptId/control`

```json
{
  "action": "pause",
  "reason": "Review the recorded application event",
  "commandId": "a fresh UUID for this human command",
  "incidentId": null
}
```

Actions are `pause`, `resume` and `end`. Reasons must contain 1–1000 nonblank characters. An optional proctor incident ID must belong to the same teacher, student, session and attempt. The current progress UI records a human reason without automatically attaching an incident ID; it does not decide that a flag warrants a penalty.

Migration `008_exam_controls.sql` adds `paused_at`, `control_reason` and the append-only application control ledger. The attempt transition, receipt and `paper_audit` record are committed in one SQL statement. An audit failure rolls back the transition. Replay of an identical command ID returns its original receipt; conflicting reuse is rejected. A receipt confirms server persistence, not that a disconnected student's UI or an OS agent has acknowledged the message.

Existing teacher JWT and ownership checks apply. Foreign-teacher and device-token control requests are denied. Full administrator/invigilator role management remains P1-03; no universal administrator permission was added. The single-server serialization model is unchanged.

Incident history now accepts validated `studentId` and `sessionId` filters while retaining teacher ownership checks and pagination. Progress provides pending observation/application counts and the latest 200 manual control records for the selected session. History beyond this bound is retained in SQL but not paginated in this increment.

## Evidence scope and limits

Existing executable allowlist alerts, consented window events, and optional person/phone camera observations are reused. Camera snapshots/clips still require their existing separate consent. No new screen-snapshot collection was added, and an application/window event is not promised to have an image. A teacher can request a consented camera snapshot from incident details. Migration 009 links the resulting camera-check evidence to that source incident without changing the source observation or duplicating media. This is a later camera check, not a snapshot of the original screen/window event. Phone observations retain their automatic camera-snapshot path when consented.

Website/AI-service access detection still requires the managed-browser integration in P1-02. This increment does not manufacture those events. Gaze, head direction, attention, emotion, identity inference and automatic penalties are excluded. Browser examination controls cannot stop unrelated operating-system applications. Regulatory compliance and managed OS lockdown require separate assessment and validation; neither is claimed here.

## Validation

- `npm test`: includes SQL-backed control tests for ownership, invalid input, pause/save/submit/PDF enforcement, unchanged deadlines, unaffected students, replay/conflict, duplicate end, audit-failure rollback, terminal state, timeout and incident filtering/dismissal.
- `node tests/exam-controls-browser.mjs`: actual teacher/student browser workflow, progress filter, protected codec-fixture snapshot, dismissal, pause across reload, read-only response, disabled submit, resume and individual end. Set `EXAMOS_TEST_BROWSER=chrome` to use an installed system Chrome. Optional `EXAMOS_TEST_ARTIFACT_DIR` writes screenshots to a specified private local directory.
- The evidence fixture is explicitly synthetic JPEG codec data, not an actual camera detection. Real hardware, packaged native agent, physical LAN and native PostgreSQL acceptance are not established by these tests.

Install migrations 008 and 009 and rebuild the dashboard during a planned upgrade outside active examinations. No live service was restarted for this implementation. Consult PROJECT-STATUS.md for the actual checks run on this branch.

## Phone, app and window-event pipeline acceptance (31 October 2026)

`node tests/policy-review-browser.mjs` exercises the authenticated Socket.IO sample/event paths, student DOM event handlers and HTTP routes, persistent flags/evidence, teacher UI, dismissal and manual pause/end. It uses an explicit JPEG codec fixture and synthetic focus/fullscreen-exit DOM events; it does not claim camera inference or physical OS activity.

Checks include missing camera/snapshot/screen/window-event consent, allowed versus prohibited executable names, foreign-teacher media denial, invalid incident linkage, camera-without-snapshot permission denial, and no control action before the human submits one. Repeated browser events of the same category/attempt are coalesced for ten seconds. Started examination app violations appear as `prohibited_application`; sessions without a started assigned attempt retain the existing `rule_alert` behavior.

Linked media remain private and subject to the existing retention/deletion checks. The incident dialog refreshes linked evidence and displays deleted/expired states. A snapshot request confirms an agent acknowledgement first; it does not claim a stored image until an evidence receipt arrives. Camera/snapshot withdrawal prevents the request or subsequent upload. No gaze/attention classifier, OS lockdown or website telemetry was added.

### Physical acceptance still required

1. Build/run the actual Windows agent in an isolated test examination; record source/build hash and OS. Use a visible consented test desktop with private content closed.
2. Start an assigned exam, separately allow camera analysis and snapshots, and present a real phone for at least the existing two-second sustained threshold. Verify the actual image, device/session/attempt, detection/capture times and teacher flag. Repeat with snapshot permission off: no image may be stored.
3. With screen/application consent on, switch to an executable outside the session allowlist. Verify the executable reported in the incident. An allowed executable must not create that policy flag.
4. With examination-window consent on, actually leave the window and exit fullscreen. Verify the recorded event categories. Repeat with that consent off and verify no window-event record.
5. Request a camera snapshot from one of those incidents with fresh camera/snapshot consent. Verify its later capture time and link; withdraw consent and verify subsequent capture/upload is denied.
6. Dismiss a flag, pause/resume one attempt and check the continuing deadline, then end it. Verify acknowledged answers, classmates' unaffected status and the audit receipts. Delete private test media after verification.

A real phone may be missed or falsely detected; these remain reviewable object observations. The scripted codec pipeline test does not close the upstream incomplete packaged automatic-detection acceptance.

## Integration handoff - 31 October 2026

Publish this work as `feature/incident-review-controls`, based on `0178aea`. At publication preparation, the friend's separate remote branch `p0-02-monitoring-lifecycle` was at `33c1bb2`. This feature does not include or replace that branch's work. Both branches and `main` must remain intact.

Merge this feature into the chosen integration branch using a normal merge; do not reset or force-push over the friend's branch. Both workstreams modify `server/app.js`, `dashboard/src/main.jsx`, ARCHITECTURE.md and several project status/requirements/memory/testing documents. Combine the monitoring lease/focused-screen changes with the incident/control paths when resolving conflicts. The friend's inspected branch has migrations through 007; this feature adds 008 and 009. Recheck migration numbering against the actual integration head before merging.

After integration, rerun the combined branch's build, complete Node suite, monitoring/focused-screen browser tests, exam-control browser test and policy-review browser test. Branch-local passing tests do not establish acceptance of the merged result. Preserve both workstreams' native-hardware limitations and observed evidence in the merged documentation.

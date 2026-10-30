import { randomUUID } from "node:crypto";
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = (status, message) => Object.assign(Error(message), { status });

// Human-issued controls only. A detector never calls this handler.
export function installExamControls({
  teacher,
  db,
  route,
  emit,
  reconcile,
  onAttemptFinished,
}) {
  teacher.post(
    "/sessions/:id/attempts/:attemptId/control",
    route(async (req, res) => {
      const { action, commandId, incidentId = null } = req.body;
      const reason =
        typeof req.body.reason === "string" ? req.body.reason.trim() : "";
      if (
        !uuid(req.params.id) ||
        !uuid(req.params.attemptId) ||
        !uuid(commandId) ||
        !["pause", "resume", "end"].includes(action) ||
        !reason ||
        reason.length > 1000 ||
        (incidentId !== null && !uuid(incidentId))
      )
        throw fail(
          400,
          "Choose a control and provide a reason of 1–1000 characters and a command ID.",
        );
      const prior = (
        await db.query(
          "SELECT * FROM exam_controls WHERE id=$1 AND teacher_id=$2",
          [commandId, req.teacher],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.attempt_id !== req.params.attemptId ||
          prior.session_id !== req.params.id ||
          prior.action !== action ||
          prior.reason !== reason ||
          prior.incident_id !== incidentId
        )
          throw fail(409, "Command ID already used for a different control.");
        return res.json({ ok: true, receipt: prior, duplicate: true });
      }
      await reconcile(req.teacher);
      const x = (
        await db.query(
          "SELECT x.* FROM exam_attempts x JOIN sessions s ON s.id=x.session_id JOIN devices d ON d.id=x.device_id WHERE x.id=$1 AND x.session_id=$2 AND s.teacher_id=$3 AND d.teacher_id=$3 AND NOT d.revoked AND s.status='active'",
          [req.params.attemptId, req.params.id, req.teacher],
        )
      ).rows[0];
      if (!x) throw fail(404, "Active student attempt not found.");
      if (
        !["started", "opened"].includes(x.status) ||
        (action !== "end" && x.status !== "started") ||
        (x.deadline_at && new Date(x.deadline_at) <= new Date())
      )
        throw fail(409, "This attempt cannot accept this control.");
      if (
        (action === "pause" && x.paused_at) ||
        (action === "resume" && !x.paused_at)
      )
        throw fail(
          409,
          "The pause state has changed. Refresh before issuing a new control.",
        );
      if (
        incidentId &&
        !(
          await db.query(
            "SELECT 1 FROM proctor_events WHERE id=$1 AND teacher_id=$2 AND attempt_id=$3 AND device_id=$4 AND session_id=$5",
            [incidentId, req.teacher, x.id, x.device_id, x.session_id],
          )
        ).rows.length
      )
        throw fail(404, "Incident does not belong to this attempt.");
      // Fixed SQL fragments, never user-provided SQL. Audit and state commit together.
      const change =
        action === "pause"
          ? "paused_at=now(),control_reason=$2"
          : action === "resume"
            ? "paused_at=NULL,control_reason=$2"
            : "paused_at=NULL,control_reason=$2,status=CASE WHEN status='opened' THEN 'cancelled' ELSE 'submitted' END,submitted_at=now(),submission_reason='teacher_ended',focus_consent=false";
      const receipt = (
        await db.query(
          `WITH changed AS (UPDATE exam_attempts SET ${change} WHERE id=$1 AND status IN ('opened','started') AND (deadline_at IS NULL OR deadline_at>now()) RETURNING *), logged AS (INSERT INTO exam_controls(id,teacher_id,attempt_id,session_id,device_id,action,reason,incident_id) SELECT $3,$4,id,session_id,device_id,$5,$2,$6 FROM changed RETURNING *), audited AS (INSERT INTO paper_audit(id,teacher_id,paper_id,session_id,device_id,action,detail) SELECT $7,$4,p.paper_id,c.session_id,c.device_id,'exam_control',jsonb_build_object('commandId',c.id,'action',c.action,'reason',c.reason,'incidentId',c.incident_id,'timerPolicy','deadline_continues') FROM logged c JOIN session_papers p ON p.session_id=c.session_id RETURNING id) SELECT logged.* FROM logged WHERE EXISTS(SELECT 1 FROM audited)`,
          [
            x.id,
            reason,
            commandId,
            req.teacher,
            action,
            incidentId,
            randomUUID(),
          ],
        )
      ).rows[0];
      if (!receipt)
        throw fail(409, "The attempt changed before this control was applied.");
      if (action === "end") onAttemptFinished(x.device_id, x.session_id);
      emit(req.teacher);
      res.json({ ok: true, receipt, duplicate: false });
    }),
  );
}

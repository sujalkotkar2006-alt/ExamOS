import { randomUUID } from "node:crypto";
const uuid = (x) =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const issue = (status, message) => Object.assign(Error(message), { status });
export function installEvidence({
  teacher,
  db,
  route,
  event,
  notify,
  online,
  activeAttempt,
  labels,
}) {
  const select = `SELECT a.*,d.name AS student_name,s.name AS session_name,e.category,e.clip_status,e.clip_metadata,
 CASE WHEN a.status='deleted' OR e.evidence_deleted_at IS NOT NULL THEN 'deleted'
 WHEN LEAST(a.expires_at,e.evidence_expires_at)<=now() THEN 'expired'
 WHEN a.status='expired' THEN 'expired'
 WHEN (a.kind='snapshot' AND e.evidence IS NULL) OR (a.kind='clip' AND e.clip IS NULL) THEN 'missing'
 ELSE 'available' END AS availability
 FROM evidence_assets a JOIN proctor_events e ON e.id=a.event_id JOIN devices d ON d.id=a.student_id JOIN sessions s ON s.id=a.session_id`;
  teacher.get(
    "/evidence",
    route(async (req, res) => {
      const args = [req.teacher],
        where = ["a.teacher_id=$1"];
      for (const [param, column] of [
        ["studentId", "student_id"],
        ["sessionId", "session_id"],
        ["eventId", "event_id"],
      ]) {
        if (req.query[param]) {
          if (!uuid(req.query[param]))
            throw issue(400, "Invalid evidence filter");
          args.push(req.query[param]);
          where.push(`a.${column}=$${args.length}`);
        }
      }
      if (req.query.kind) {
        if (!["snapshot", "clip"].includes(req.query.kind))
          throw issue(400, "Invalid evidence kind");
        args.push(req.query.kind);
        where.push("a.kind=$" + args.length);
      }
      if (req.query.category) {
        if (!Object.hasOwn(labels, req.query.category))
          throw issue(400, "Invalid event category");
        args.push(req.query.category);
        where.push("e.category=$" + args.length);
      }
      if (req.query.search) {
        if (
          typeof req.query.search !== "string" ||
          req.query.search.length > 100
        )
          throw issue(400, "Invalid evidence search");
        args.push("%" + req.query.search + "%");
        where.push(
          `(a.student_id::text ILIKE $${args.length} OR d.name ILIKE $${args.length})`,
        );
      }
      for (const [param, op] of [
        ["from", ">="],
        ["to", "<"],
      ])
        if (req.query[param]) {
          const date = new Date(req.query[param]);
          if (!Number.isFinite(date.getTime()))
            throw issue(400, "Invalid date filter");
          args.push(date.toISOString());
          where.push(
            "a.captured_at" + op + "$" + args.length + "::timestamptz",
          );
        }
      if (req.query.status === "available")
        where.push(
          "a.status='available' AND LEAST(a.expires_at,e.evidence_expires_at)>now() AND CASE WHEN a.kind='snapshot' THEN e.evidence IS NOT NULL ELSE e.clip IS NOT NULL END",
        );
      else if (req.query.status && req.query.status !== "all")
        throw issue(400, "Invalid evidence availability");
      const limit = Number(req.query.limit ?? 24),
        offset = Number(req.query.offset ?? 0);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 100000
      )
        throw issue(400, "Invalid evidence pagination");
      const clause = where.join(" AND "),
        total = (
          await db.query(
            "SELECT count(*)::integer AS n FROM evidence_assets a JOIN devices d ON d.id=a.student_id JOIN proctor_events e ON e.id=a.event_id WHERE " +
              clause,
            args,
          )
        ).rows[0].n;
      const rows = (
        await db.query(
          select +
            " WHERE " +
            clause +
            ` ORDER BY a.captured_at DESC,a.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, limit, offset],
        )
      ).rows;
      res.json({
        items: rows.map((r) => ({
          ...r,
          label: labels[r.category],
          content_url: "/api/proctor/evidence/" + r.id + "/content",
        })),
        total,
        limit,
        offset,
      });
    }),
  );
  teacher.get(
    "/evidence/:id/content",
    route(async (req, res) => {
      if (!uuid(req.params.id)) throw issue(404, "Evidence not found");
      const row = (
        await db.query(select + " WHERE a.id=$1 AND a.teacher_id=$2", [
          req.params.id,
          req.teacher,
        ])
      ).rows[0];
      if (!row) throw issue(404, "Evidence not found");
      if (row.availability !== "available")
        throw issue(
          410,
          "Evidence " +
            row.availability +
            (row.availability === "missing"
              ? "; stored media bytes are unavailable"
              : ""),
        );
      const media = (
        await db.query(
          "SELECT CASE WHEN $2='snapshot' THEN evidence ELSE clip END AS bytes FROM proctor_events WHERE id=$1 AND teacher_id=$3 AND evidence_expires_at>now()",
          [row.event_id, row.kind, req.teacher],
        )
      ).rows[0];
      if (!media?.bytes) throw issue(410, "Evidence missing or expired");
      await event(
        req.teacher,
        row.session_id,
        row.student_id,
        "evidence_viewed",
        { observationId: row.event_id, evidenceId: row.id, kind: row.kind },
      );
      res
        .set({
          "Content-Type": row.mime_type,
          "Content-Disposition": `inline; filename="${row.kind}-${row.id}.${row.kind === "snapshot" ? "jpg" : "webm"}"`,
          "Cache-Control": "no-store",
        })
        .send(Buffer.from(media.bytes));
    }),
  );
  teacher.get(
    "/summary",
    route(async (req, res) => {
      const counts = (
        await db.query(
          "SELECT count(*) FILTER(WHERE a.kind='snapshot')::integer AS snapshots_captured,count(*) FILTER(WHERE a.kind='snapshot' AND a.status='available' AND e.evidence IS NOT NULL AND LEAST(a.expires_at,e.evidence_expires_at)>now())::integer AS snapshots_available,count(*) FILTER(WHERE a.kind='clip' AND a.status='available' AND e.clip IS NOT NULL AND LEAST(a.expires_at,e.evidence_expires_at)>now())::integer AS videos_available FROM evidence_assets a JOIN proctor_events e ON e.id=a.event_id WHERE a.teacher_id=$1",
          [req.teacher],
        )
      ).rows[0];
      const active = (
        await db.query(
          "SELECT count(*)::integer AS n FROM sessions s WHERE teacher_id=$1 AND status='active' AND NOT EXISTS(SELECT 1 FROM session_papers p WHERE p.session_id=s.id AND p.closes_at<=now())",
          [req.teacher],
        )
      ).rows[0].n;
      const pending = (
        await db.query(
          "SELECT count(*)::integer AS n FROM proctor_events WHERE teacher_id=$1 AND review_status='pending'",
          [req.teacher],
        )
      ).rows[0].n;
      const connected = [...online.values()].filter(
        (o) => o.teacher === req.teacher && Date.now() - o.lastSeen < 8000,
      );
      const profile = (
        await db.query("SELECT email FROM teachers WHERE id=$1", [req.teacher])
      ).rows[0];
      res.json({
        ...counts,
        teacher_email: profile?.email,
        active_examinations: active,
        connected_students: connected.length,
        active_cameras: connected.filter(
          (o) => o.cameraStatus === "active" && o.cameraConsent,
        ).length,
        pending_incidents: pending,
      });
    }),
  );
  teacher.get(
    "/incidents",
    route(async (req, res) => {
      const limit = 50,
        offset = Number(req.query.offset ?? 0);
      if (!Number.isInteger(offset) || offset < 0)
        throw issue(400, "Invalid history page");
      const filters = [req.teacher];
      let scope = "e.teacher_id=$1";
      for (const [key, column] of [
        ["studentId", "device_id"],
        ["sessionId", "session_id"],
      ]) {
        if (req.query[key]) {
          if (!uuid(req.query[key]))
            throw issue(400, "Invalid incident filter");
          filters.push(req.query[key]);
          scope += ` AND e.${column}=$${filters.length}`;
        }
      }
      const events = (
        await db.query(
          `SELECT e.id,e.session_id,e.device_id,e.attempt_id,d.name AS device_name,s.name AS session_name,e.category,e.detail,e.observed_at,e.received_at,(e.evidence IS NOT NULL AND e.evidence_expires_at>now()) AS has_evidence,(e.clip IS NOT NULL AND e.evidence_expires_at>now()) AS has_clip,e.clip_status,e.clip_metadata,e.review_status,e.review_note,e.reviewed_at,e.evidence_expires_at FROM proctor_events e JOIN devices d ON d.id=e.device_id JOIN sessions s ON s.id=e.session_id WHERE ${scope} ORDER BY e.received_at DESC,e.id LIMIT $${filters.length + 1} OFFSET $${filters.length + 2}`,
          [...filters, limit, offset],
        )
      ).rows;
      const total = (
        await db.query(
          "SELECT count(*)::integer AS n FROM proctor_events e WHERE " + scope,
          filters,
        )
      ).rows[0].n;
      res.json({
        events: events.map((e) => ({ ...e, label: labels[e.category] })),
        total,
        limit,
        offset,
      });
    }),
  );
  teacher.delete(
    "/evidence/:id",
    route(async (req, res) => {
      if (!uuid(req.params.id)) throw issue(404, "Evidence not found");
      const row = (
        await db.query(
          "SELECT * FROM evidence_assets WHERE id=$1 AND teacher_id=$2",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      if (!row) throw issue(404, "Evidence not found");
      await db.query(
        `WITH cleared AS (UPDATE proctor_events SET ${row.kind === "snapshot" ? "evidence=NULL" : "clip=NULL,clip_status='deleted'"} WHERE id=$1 AND teacher_id=$2 RETURNING id) UPDATE evidence_assets SET status='deleted' WHERE id=$3 AND event_id IN (SELECT id FROM cleared)`,
        [row.event_id, req.teacher, row.id],
      );
      await event(
        req.teacher,
        row.session_id,
        row.student_id,
        "evidence_asset_deleted",
        { observationId: row.event_id, evidenceId: row.id, kind: row.kind },
      );
      notify(req.teacher);
      res.json({ ok: true });
    }),
  );
  teacher.post(
    "/devices/:id/camera-check",
    route(async (req, res) => {
      if (!uuid(req.params.id)) throw issue(404, "Device not found");
      const d = (
        await db.query(
          "SELECT * FROM devices WHERE id=$1 AND teacher_id=$2 AND NOT revoked",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      if (!d) throw issue(404, "Device not found");
      const o = online.get(d.id);
      if (!o || Date.now() - o.lastSeen > 8000)
        throw issue(
          409,
          "Student agent is disconnected or its heartbeat expired",
        );
      if (!o.cameraConsent || o.cameraStatus !== "active")
        throw issue(
          409,
          "Student must start their examination and explicitly start the camera first",
        );
      if (!o.snapshotConsent)
        throw issue(
          403,
          "Student has not consented to event snapshots; the teacher cannot enable this remotely",
        );
      const attempt = await activeAttempt(d, o.cameraConsent);
      if (!attempt) throw issue(409, "Student examination is not in progress");
      const incidentId = req.body.incidentId ?? null;
      if (
        incidentId !== null &&
        (!uuid(incidentId) ||
          !(
            await db.query(
              "SELECT 1 FROM proctor_events WHERE id=$1 AND teacher_id=$2 AND device_id=$3 AND session_id=$4 AND attempt_id=$5",
              [incidentId, req.teacher, d.id, o.cameraConsent, attempt.id],
            )
          ).rows.length)
      )
        throw issue(
          404,
          "Incident does not belong to this active student attempt",
        );
      if (Date.now() - (o.lastTeacherCheck || 0) < 5000)
        throw issue(
          429,
          "Wait five seconds before requesting another camera check",
        );
      const pending = (
        await db.query(
          "SELECT 1 FROM camera_check_requests WHERE device_id=$1 AND status='queued' AND expires_at>now()",
          [d.id],
        )
      ).rows[0];
      if (pending)
        throw issue(
          409,
          "A camera check is already waiting for the student agent",
        );
      const id = randomUUID();
      o.lastTeacherCheck = Date.now();
      await db.query(
        "INSERT INTO camera_check_requests(id,teacher_id,device_id,session_id,source_event_id) VALUES ($1,$2,$3,$4,$5)",
        [id, req.teacher, d.id, o.cameraConsent, incidentId],
      );
      await event(
        req.teacher,
        o.cameraConsent,
        d.id,
        "camera_check_requested",
        { requestId: id, observationId: incidentId },
      );
      try {
        const ack = await o.socket
          .timeout(3000)
          .emitWithAck("camera-check-request", {
            requestId: id,
            sessionId: o.cameraConsent,
          });
        if (!ack?.ok)
          throw Error(ack?.error || "Agent did not accept the camera check");
      } catch (e) {
        await db.query(
          "UPDATE camera_check_requests SET status='failed',error=$2 WHERE id=$1 AND status='queued'",
          [
            id,
            e.message ||
              "Agent did not acknowledge; update or reconnect the student agent",
          ],
        );
        notify(req.teacher);
        throw issue(
          502,
          "Camera check not acknowledged. Update/reconnect the student agent and verify its visible camera and snapshot consent.",
        );
      }
      notify(req.teacher);
      res.status(202).json({
        requestId: id,
        status: "queued",
        message:
          "Agent acknowledged. Waiting for an actual consented webcam frame.",
      });
    }),
  );
}

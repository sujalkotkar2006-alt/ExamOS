import express from "express";
import { randomUUID, createHash } from "node:crypto";
import jpeg from "jpeg-js";
import { validateClip } from "./media.js";
import { installEvidence } from "./evidence.js";
export const PROCTOR_CATEGORIES = {
  camera_check: "Student-authorized camera check (not an alert)",
  phone_detected: "Possible mobile phone detected",
  no_person_detected: "No person detected in frame",
  multiple_people: "Multiple people visible",
  camera_obstructed: "Camera image dark or obstructed",
  camera_unavailable: "Camera unavailable",
  camera_disconnected: "Camera disconnected",
  application_switch: "Application switch observed",
  prohibited_application: "Application outside the examination allowlist",
  window_blur: "Examination window lost focus",
  navigation_attempt: "Examination navigation attempt",
  fullscreen_exit: "Full-screen mode exited",
};
const cameraCategories = new Set([
  "camera_check",
  "phone_detected",
  "no_person_detected",
  "multiple_people",
  "camera_obstructed",
]);
const technicalCategories = new Set([
  "camera_unavailable",
  "camera_disconnected",
]);
const browserCategories = new Set([
  "window_blur",
  "navigation_attempt",
  "fullscreen_exit",
]);
const issue = (status, message) =>
  Object.assign(new Error(message), { status });
export function installProctoring({
  app,
  db,
  auth,
  route,
  serialize,
  online,
  exams,
  event,
  notify,
  incidentNotify,
  stopDevice,
}) {
  async function settings(teacher) {
    const row = (
      await db.query(
        "SELECT retention_days,cooldown_seconds,clip_seconds FROM proctor_settings WHERE teacher_id=$1",
        [teacher],
      )
    ).rows[0];
    return {
      retentionDays: row?.retention_days || 7,
      cooldownSeconds: row?.cooldown_seconds || 30,
      clipSeconds: row?.clip_seconds || 10,
      snapshotsOnly: false,
      identityRecognition: false,
      attentionInference: false,
    };
  }
  async function activeAttempt(device, sessionId) {
    return (
      await db.query(
        "SELECT x.* FROM exam_attempts x JOIN sessions s ON s.id=x.session_id JOIN session_papers p ON p.session_id=s.id WHERE x.device_id=$1 AND x.session_id=$2 AND s.teacher_id=$3 AND s.status='active' AND x.status='started' AND x.deadline_at>now() AND p.opens_at<=now() AND p.closes_at>now()",
        [device.id, sessionId, device.teacher_id],
      )
    ).rows[0];
  }
  async function examState(device, sessionId) {
    if (!sessionId) return null;
    const row = (
      await db.query(
        "SELECT status,deadline_at,submitted_at FROM exam_attempts WHERE device_id=$1 AND session_id=$2",
        [device.id, sessionId],
      )
    ).rows[0];
    return row || null;
  }
  async function saveObservation(
    device,
    sessionId,
    p,
    {
      cameraAllowed = false,
      snapshotAllowed = false,
      retentionDays = 7,
      clipAllowed = false,
    } = {},
  ) {
    if (!Object.hasOwn(PROCTOR_CATEGORIES, p?.category))
      throw issue(
        400,
        "Unsupported observation category. Gaze, emotion, attention and cheating inference are not supported.",
      );
    const attempt = await activeAttempt(device, sessionId);
    if (!attempt)
      throw issue(
        409,
        "Observations require this device’s active, started examination",
      );
    if (cameraCategories.has(p.category) && !cameraAllowed)
      throw issue(403, "Camera consent is required");
    if (
      p.jpeg &&
      (!snapshotAllowed || !cameraAllowed || !cameraCategories.has(p.category))
    )
      throw issue(403, "Separately consented camera evidence is required");
    if (p.detail && typeof p.detail !== "object")
      throw issue(400, "Invalid observation detail");
    if (
      p.detail?.confidence !== undefined &&
      (!Number.isFinite(p.detail.confidence) ||
        p.detail.confidence < 0 ||
        p.detail.confidence > 1)
    )
      throw issue(400, "Detection confidence must be between zero and one");
    const detail = {};
    if (
      p.category === "prohibited_application" &&
      typeof p.detail?.app === "string" &&
      p.detail.app.length <= 120
    )
      detail.app = p.detail.app;
    for (const k of [
      "personCount",
      "phoneCount",
      "confidence",
      "seconds",
      "mode",
    ]) {
      const v = p.detail?.[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10000)
        detail[k] = v;
      if (k === "mode" && ["limited_edge", "browser_only"].includes(v))
        detail.mode = v;
    }
    if (p.clientEventId) {
      if (!/^[0-9a-f-]{36}$/i.test(p.clientEventId))
        throw issue(400, "Invalid client event ID");
      detail.clientEventId = p.clientEventId;
      detail.captureSha256 = createHash("sha256")
        .update(Buffer.from(p.jpeg || "", "base64"))
        .digest("hex");
    }
    detail.interpretation =
      "Potential Examination Incident. Observation only. No automatic finding of misconduct.";
    if (p.requestId) {
      if (
        p.category !== "camera_check" ||
        !/^[0-9a-f-]{36}$/i.test(p.requestId)
      )
        throw issue(400, "Invalid camera check request");
      const requested = (
        await db.query(
          "SELECT 1 FROM camera_check_requests WHERE id=$1 AND teacher_id=$2 AND device_id=$3 AND session_id=$4 AND status='queued' AND expires_at>now()",
          [p.requestId, device.teacher_id, device.id, sessionId],
        )
      ).rows[0];
      if (!requested)
        throw issue(
          409,
          "Camera check request expired or belongs to another device",
        );
      if (!p.jpeg)
        throw issue(
          400,
          "A requested camera check must include the actual snapshot",
        );
      detail.cameraCheckRequestId = p.requestId;
    }
    let evidence = null;
    if (p.jpeg) {
      if (
        typeof p.jpeg !== "string" ||
        p.jpeg.length > 120000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(p.jpeg)
      )
        throw issue(400, "Invalid snapshot");
      const bytes = Buffer.from(p.jpeg, "base64");
      try {
        const image = jpeg.decode(bytes, {
          maxMemoryUsageInMB: 16,
          maxResolutionInMP: 1,
          useTArray: true,
        });
        if (!image.width || image.width > 640 || image.height > 480)
          throw Error();
      } catch {
        throw issue(400, "Snapshot must be a valid JPEG of at most 640×480");
      }
      evidence = bytes;
    }
    const observed = new Date(p.observedAt || Date.now());
    if (
      !Number.isFinite(observed.getTime()) ||
      observed.getTime() - Date.now() > 60000 ||
      Date.now() - observed.getTime() > (p.clientEventId ? 900000 : 60000)
    )
      throw issue(
        400,
        "Observation timestamp is outside the permitted clock window",
      );
    if (observed < new Date(attempt.started_at))
      throw issue(400, "Capture predates the examination attempt");
    const policy = await settings(device.teacher_id),
      days = Math.min(retentionDays, policy.retentionDays),
      id = randomUUID();
    const clipExpected = clipAllowed && p.clipExpected === true && !!evidence;
    const captured = new Date(p.capturedAt || observed);
    if (
      !Number.isFinite(captured.getTime()) ||
      captured > observed ||
      observed - captured > 15000
    )
      throw issue(400, "Invalid snapshot capture timestamp");
    const assetId = randomUUID();
    await db.query(
      "WITH inserted AS (INSERT INTO proctor_events(id,teacher_id,session_id,device_id,category,detail,observed_at,evidence,evidence_expires_at,attempt_id,clip_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::bytea IS NULL THEN NULL ELSE now()+($9*interval '1 day') END,$10,$11) RETURNING *), asset AS (INSERT INTO evidence_assets(id,event_id,teacher_id,student_id,session_id,examination_id,kind,mime_type,storage_location,captured_at,capture_time_source,byte_size,expires_at) SELECT $12,id,teacher_id,device_id,session_id,attempt_id,'snapshot','image/jpeg','postgresql:proctor_events/'||id||'/evidence',$13,$14,octet_length(evidence),evidence_expires_at FROM inserted WHERE evidence IS NOT NULL RETURNING id), completed AS (UPDATE camera_check_requests SET status='captured',event_id=(SELECT id FROM inserted) WHERE id=$15::uuid AND status='queued' RETURNING id) SELECT id FROM inserted",
      [
        id,
        device.teacher_id,
        sessionId,
        device.id,
        p.category,
        JSON.stringify(detail),
        observed.toISOString(),
        evidence,
        days,
        attempt.id,
        clipExpected ? "pending" : "not_consented",
        assetId,
        captured.toISOString(),
        p.capturedAt ? "capture" : "detection",
        p.requestId || null,
      ],
    );
    await event(
      device.teacher_id,
      sessionId,
      device.id,
      "proctor_observation",
      {
        observationId: id,
        category: p.category,
        label: PROCTOR_CATEGORIES[p.category],
        hasEvidence: !!evidence,
        interpretation: detail.interpretation,
      },
    );
    notify(device.teacher_id);
    const names = (
      await db.query(
        "SELECT d.name,s.name AS session_name FROM devices d JOIN sessions s ON s.id=$2 WHERE d.id=$1",
        [device.id, sessionId],
      )
    ).rows[0];
    incidentNotify?.(device.teacher_id, {
      id,
      device_id: device.id,
      device_name: names?.name,
      session_id: sessionId,
      session_name: names?.session_name,
      attempt_id: attempt.id,
      category: p.category,
      label: PROCTOR_CATEGORIES[p.category],
      observed_at: observed.toISOString(),
      confidence: detail.confidence ?? null,
      has_evidence: !!evidence,
      clip_status: clipExpected ? "pending" : "not_consented",
    });
    return {
      id,
      hasEvidence: !!evidence,
      evidenceId: evidence ? assetId : null,
      clipExpected,
    };
  }
  function clearCamera(o, status = "off") {
    o.cameraConsent = null;
    o.snapshotConsent = false;
    o.clipConsent = false;
    o.cameraGrant = null;
    o.cameraStatus = status;
  }
  function attachDevice({ on, d, o, active }) {
    on("camera-consent", async (p, ack) => {
      const s = await active(d.teacher_id);
      if (!s || p?.sessionId !== s.id || typeof p.accept !== "boolean")
        throw issue(409, "No active examination");
      if (!p.accept) {
        clearCamera(o);
        await db.query(
          "UPDATE camera_check_requests SET status='failed',error='Student withdrew camera consent before capture' WHERE device_id=$1 AND status='queued'",
          [d.id],
        );
        await event(d.teacher_id, s.id, d.id, "camera_consent_withdrawn", {});
        notify(d.teacher_id);
        ack?.({ ok: true });
        return;
      }
      if (!(await activeAttempt(d, s.id)))
        throw issue(409, "Start the assigned examination before camera access");
      if (Date.now() - o.lastSeen > 8000)
        throw issue(409, "A current device heartbeat is required");
      const policy = await settings(d.teacher_id);
      const requestedDays = p.retentionDays ?? policy.retentionDays,
        requestedClip = p.clipSeconds ?? policy.clipSeconds,
        requestedCooldown = p.cooldownSeconds ?? policy.cooldownSeconds;
      if (
        !Number.isInteger(requestedDays) ||
        requestedDays < 1 ||
        requestedDays > 30 ||
        !Number.isInteger(requestedClip) ||
        requestedClip < 4 ||
        requestedClip > 20 ||
        !Number.isInteger(requestedCooldown) ||
        requestedCooldown < 10 ||
        requestedCooldown > 300
      )
        throw issue(400, "Invalid evidence consent limits");
      o.cameraConsent = s.id;
      o.snapshotConsent = p.snapshots === true;
      o.clipConsent = p.clips === true && o.snapshotConsent;
      o.cameraGrant = randomUUID();
      o.cameraClipSeconds = Math.min(policy.clipSeconds, requestedClip);
      o.cameraCooldown = Math.max(policy.cooldownSeconds, requestedCooldown);
      o.cameraRetentionDays = Math.min(policy.retentionDays, requestedDays);
      o.cameraStatus = "starting";
      await event(d.teacher_id, s.id, d.id, "camera_consent_granted", {
        snapshots: o.snapshotConsent,
        clips: o.clipConsent,
        clipSeconds: o.clipConsent ? o.cameraClipSeconds : 0,
        cooldownSeconds: o.cameraCooldown,
        retentionDays: o.cameraRetentionDays,
        noAudio: true,
      });
      notify(d.teacher_id);
      ack?.({
        ok: true,
        ...policy,
        retentionDays: o.cameraRetentionDays,
        clipSeconds: o.cameraClipSeconds,
        cooldownSeconds: o.cameraCooldown,
        grantId: o.cameraGrant,
        serverNow: new Date().toISOString(),
      });
    });
    on("camera-status", async (p, ack) => {
      const s = await active(d.teacher_id);
      if (!s || s.id !== p?.sessionId) throw issue(409, "Session unavailable");
      if (!["active", "off", "unavailable", "disconnected"].includes(p.status))
        throw issue(400, "Invalid camera status");
      if (p.status !== "off" && o.cameraConsent !== s.id)
        throw issue(403, "Camera consent required");
      if (
        p.status === "active" &&
        (o.cameraConsent !== s.id || !(await activeAttempt(d, s.id)))
      )
        throw issue(
          403,
          "Camera permission and a started examination are required",
        );
      o.cameraStatus = p.status;
      if (p.status !== "active") clearCamera(o, p.status);
      if (
        ["unavailable", "disconnected"].includes(p.status) &&
        (await activeAttempt(d, s.id))
      )
        await saveObservation(d, s.id, { category: "camera_" + p.status });
      notify(d.teacher_id);
      ack?.({ ok: true });
    });
    on("proctor-event", async (p, ack) => {
      console.info(
        JSON.stringify({
          stage: "upload_received_authenticated",
          deviceId: d.id,
          sessionId: p?.sessionId,
        }),
      );
      if (
        (p?.deviceId && p.deviceId !== d.id) ||
        (p?.studentId && p.studentId !== d.id)
      )
        throw issue(403, "Evidence device identity mismatch");
      if (p?.clientEventId) {
        if (!/^[0-9a-f-]{36}$/i.test(p.clientEventId))
          throw issue(400, "Invalid client event ID");
        const prior = (
          await db.query(
            "SELECT e.*,a.id AS asset_id FROM proctor_events e LEFT JOIN evidence_assets a ON a.event_id=e.id AND a.kind='snapshot' WHERE e.device_id=$1 AND e.teacher_id=$2 AND e.detail->>'clientEventId'=$3",
            [d.id, d.teacher_id, p.clientEventId],
          )
        ).rows[0];
        if (prior) {
          const hash = createHash("sha256")
            .update(Buffer.from(p.jpeg || "", "base64"))
            .digest("hex");
          if (
            prior.session_id !== p.sessionId ||
            prior.category !== p.category ||
            prior.detail.captureSha256 !== hash
          )
            throw issue(
              409,
              "Client event ID already used for different evidence",
            );
          if (
            prior.evidence_deleted_at ||
            (prior.evidence_expires_at &&
              new Date(prior.evidence_expires_at) <= new Date())
          )
            throw issue(410, "Evidence expired or deleted");
          return ack?.({
            ok: true,
            id: prior.id,
            hasEvidence: !!prior.evidence,
            evidenceId: prior.asset_id,
            clipExpected: ["pending", "unavailable", "available"].includes(
              prior.clip_status,
            ),
            duplicate: true,
          });
        }
      }
      const s = await active(d.teacher_id);
      if (!s || s.id !== p?.sessionId || Date.now() - o.lastSeen > 8000)
        throw issue(409, "Active examination heartbeat required");
      if (
        !cameraCategories.has(p.category) &&
        !technicalCategories.has(p.category) &&
        p.category !== "application_switch"
      )
        throw issue(403, "Unsupported agent observation");
      if (p.category === "application_switch" && o.consented !== s.id)
        throw issue(403, "Application monitoring consent required");
      const key = p.category;
      const cooldown =
        key === "camera_check"
          ? 2000
          : cameraCategories.has(key)
            ? Math.max(
                o.cameraCooldown || 30,
                (await settings(d.teacher_id)).cooldownSeconds,
              ) * 1000
            : 10000;
      if (Date.now() - (o.proctorRate?.[key] || 0) < cooldown)
        return ack?.({
          ok: true,
          throttled: true,
          retryAfterMs: cooldown - (Date.now() - (o.proctorRate?.[key] || 0)),
        });
      let result;
      try {
        result = await saveObservation(d, s.id, p, {
          cameraAllowed: o.cameraConsent === s.id,
          snapshotAllowed: o.snapshotConsent,
          retentionDays: o.cameraRetentionDays,
          clipAllowed:
            o.clipConsent && (!p.grantId || p.grantId === o.cameraGrant),
        });
      } catch (e) {
        if (p.requestId && e.status && e.status < 500)
          await db
            .query(
              "UPDATE camera_check_requests SET status='failed',error='Snapshot upload failed or was rejected' WHERE id=$1 AND device_id=$2 AND status='queued'",
              [p.requestId, d.id],
            )
            .catch(() => {});
        notify(d.teacher_id);
        if (!e.status) {
          e.status = 503;
          e.message =
            "Snapshot could not be stored; check server storage and retry the camera check";
        }
        throw e;
      }
      o.proctorRate = { ...o.proctorRate, [key]: Date.now() };
      console.info(
        JSON.stringify({
          stage: "evidence_validated_stored_catalogued",
          deviceId: d.id,
          eventId: result.id,
          evidenceId: result.evidenceId,
        }),
      );
      ack?.({ ok: true, ...result });
    });
    on("exam-environment", async (p, ack) => {
      const s = await active(d.teacher_id);
      if (
        !s ||
        s.id !== p?.sessionId ||
        !["limited_edge", "browser_only", "closed"].includes(p.mode)
      )
        throw issue(400, "Invalid examination environment");
      o.lockdownMode = p.mode;
      await event(d.teacher_id, s.id, d.id, "exam_environment", {
        mode: p.mode,
        osLockdownVerified: false,
      });
      notify(d.teacher_id);
      ack?.({ ok: true });
    });
  }
  const teacher = express.Router();
  teacher.use(auth);
  installEvidence({
    teacher,
    db,
    route,
    event,
    notify,
    online,
    activeAttempt,
    labels: PROCTOR_CATEGORIES,
  });
  teacher.get(
    "/live",
    route(async (req, res) => {
      const rows = (
        await db.query(
          "SELECT e.id,e.session_id,e.device_id,e.attempt_id,d.name AS device_name,s.name AS session_name,e.category,e.detail,e.observed_at,e.received_at,(e.evidence IS NOT NULL AND e.evidence_expires_at>now()) AS has_evidence,(e.clip IS NOT NULL AND e.evidence_expires_at>now()) AS has_clip,e.clip_status,e.clip_metadata,e.evidence_expires_at,e.review_status,e.review_note,e.reviewed_at FROM proctor_events e JOIN devices d ON d.id=e.device_id JOIN sessions s ON s.id=e.session_id WHERE e.teacher_id=$1 ORDER BY (e.review_status='pending') DESC,e.received_at DESC LIMIT 200",
          [req.teacher],
        )
      ).rows.map((x) => ({ ...x, label: PROCTOR_CATEGORIES[x.category] }));
      const devices = (
        await db.query(
          "SELECT d.id,d.name,d.revoked,s.id AS session_id,x.id AS examination_id,x.status AS exam_status,x.focus_consent FROM devices d LEFT JOIN sessions s ON s.teacher_id=d.teacher_id AND s.status='active' LEFT JOIN exam_attempts x ON x.device_id=d.id AND x.session_id=s.id WHERE d.teacher_id=$1",
          [req.teacher],
        )
      ).rows.map((d) => {
        const o = online.get(d.id);
        return {
          ...d,
          online: !!o,
          cameraStatus: o?.cameraStatus || "off",
          cameraConsent: !!o?.cameraConsent,
          snapshots: !!o?.snapshotConsent,
          clips: !!o?.clipConsent,
          lockdownMode: o?.lockdownMode || "not_started",
        };
      });
      const checks = (
        await db.query(
          "SELECT DISTINCT ON(device_id) device_id,id,status,error,event_id,requested_at FROM camera_check_requests WHERE teacher_id=$1 ORDER BY device_id,requested_at DESC",
          [req.teacher],
        )
      ).rows;
      for (const d of devices)
        d.lastCameraCheck = checks.find((c) => c.device_id === d.id) || null;
      const latest = (
        await db.query(
          "SELECT DISTINCT ON(a.student_id) a.student_id,a.id,a.event_id,a.session_id,a.examination_id,a.captured_at,e.category FROM evidence_assets a JOIN proctor_events e ON e.id=a.event_id WHERE a.teacher_id=$1 AND a.kind='snapshot' AND a.status='available' AND e.evidence IS NOT NULL AND LEAST(a.expires_at,e.evidence_expires_at)>now() ORDER BY a.student_id,a.captured_at DESC",
          [req.teacher],
        )
      ).rows;
      for (const d of devices)
        d.latestSnapshot =
          latest.find(
            (a) =>
              a.student_id === d.id &&
              (!d.session_id || a.session_id === d.session_id),
          ) || null;
      res.json({
        events: rows,
        pendingCount: (
          await db.query(
            "SELECT count(*)::integer AS n FROM proctor_events WHERE teacher_id=$1 AND review_status='pending'",
            [req.teacher],
          )
        ).rows[0].n,
        devices,
        settings: await settings(req.teacher),
      });
    }),
  );
  teacher.get(
    "/events/:id/evidence",
    route(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id))
        throw issue(404, "Evidence not found");
      const row = (
        await db.query(
          "SELECT evidence FROM proctor_events WHERE id=$1 AND teacher_id=$2 AND evidence IS NOT NULL AND evidence_expires_at>now()",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      if (!row)
        throw issue(404, "Evidence not found or retention period expired");
      const audit = (
        await db.query(
          "SELECT session_id,device_id FROM proctor_events WHERE id=$1 AND teacher_id=$2",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      await event(
        req.teacher,
        audit.session_id,
        audit.device_id,
        "evidence_viewed",
        { observationId: req.params.id, kind: "snapshot" },
      );
      res
        .set({
          "Cache-Control": "no-store",
          "Content-Type": "image/jpeg",
          "Content-Disposition": 'inline; filename="event-evidence.jpg"',
        })
        .send(Buffer.from(row.evidence));
    }),
  );
  teacher.post(
    "/events/:id/review",
    route(async (req, res) => {
      if (
        ![
          "reviewed",
          "dismissed",
          "false_positive",
          "requires_investigation",
        ].includes(req.body.status) ||
        typeof req.body.note !== "string" ||
        req.body.note.length > 2000
      )
        throw issue(
          400,
          "Choose a review status and a note of at most 2,000 characters",
        );
      const row = (
        await db.query(
          "WITH changed AS (UPDATE proctor_events SET review_status=$1,review_note=$2,reviewed_at=now() WHERE id=$3 AND teacher_id=$4 RETURNING id,session_id,device_id), logged AS (INSERT INTO proctor_reviews(id,incident_id,teacher_id,status,comment) SELECT $5,id,$4,$1,$2 FROM changed RETURNING incident_id) SELECT changed.session_id,changed.device_id FROM changed JOIN logged ON logged.incident_id=changed.id",
          [
            req.body.status,
            req.body.note,
            req.params.id,
            req.teacher,
            randomUUID(),
          ],
        )
      ).rows[0];
      if (!row) throw issue(404, "Observation not found");
      await event(
        req.teacher,
        row.session_id,
        row.device_id,
        "proctor_review",
        {
          observationId: req.params.id,
          status: req.body.status,
          note: req.body.note,
        },
      );
      notify(req.teacher);
      res.json({ ok: true });
    }),
  );
  teacher.post(
    "/events/:id/delete-evidence",
    route(async (req, res) => {
      const row = (
        await db.query(
          "WITH cleared AS (UPDATE proctor_events SET evidence=NULL,clip=NULL,clip_status='deleted',evidence_deleted_at=now() WHERE id=$1 AND teacher_id=$2 RETURNING id,session_id,device_id), assets AS (UPDATE evidence_assets SET status='deleted' WHERE event_id IN (SELECT id FROM cleared) RETURNING id) SELECT session_id,device_id FROM cleared",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      if (!row) throw issue(404, "Observation not found");
      await event(
        req.teacher,
        row.session_id,
        row.device_id,
        "proctor_evidence_deleted",
        { observationId: req.params.id },
      );
      notify(req.teacher);
      res.json({ ok: true });
    }),
  );
  teacher.post(
    "/settings",
    route(async (req, res) => {
      const days = Number(req.body.retentionDays);
      const old = await settings(req.teacher),
        cooldown = Number(req.body.cooldownSeconds ?? old.cooldownSeconds),
        clipSeconds = Number(req.body.clipSeconds ?? old.clipSeconds);
      if (
        !Number.isInteger(cooldown) ||
        cooldown < 10 ||
        cooldown > 300 ||
        !Number.isInteger(clipSeconds) ||
        clipSeconds < 4 ||
        clipSeconds > 20
      )
        throw issue(
          400,
          "Cooldown must be 10–300 seconds and clips 4–20 seconds",
        );
      if (!Number.isInteger(days) || days < 1 || days > 30)
        throw issue(400, "Evidence retention must be 1–30 days");
      await db.query(
        "INSERT INTO proctor_settings(teacher_id,retention_days,cooldown_seconds,clip_seconds) VALUES ($1,$2,$3,$4) ON CONFLICT(teacher_id) DO UPDATE SET retention_days=EXCLUDED.retention_days,cooldown_seconds=EXCLUDED.cooldown_seconds,clip_seconds=EXCLUDED.clip_seconds",
        [req.teacher, days, cooldown, clipSeconds],
      );
      await db.query(
        "UPDATE proctor_events SET evidence_expires_at=LEAST(evidence_expires_at,now()+($2*interval '1 day')) WHERE teacher_id=$1 AND (evidence IS NOT NULL OR clip IS NOT NULL)",
        [req.teacher, days],
      );
      await db.query(
        "UPDATE evidence_assets a SET expires_at=LEAST(a.expires_at,e.evidence_expires_at) FROM proctor_events e WHERE e.id=a.event_id AND a.teacher_id=$1",
        [req.teacher],
      );
      notify(req.teacher);
      res.json({ ok: true });
    }),
  );
  app.use("/api/proctor", teacher);
  teacher.get(
    "/events/:id",
    route(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id))
        throw issue(404, "Incident not found");
      const row = (
        await db.query(
          "SELECT e.id,e.session_id,e.device_id,e.attempt_id,d.name AS device_name,s.name AS session_name,e.category,e.detail,e.observed_at,e.received_at,e.review_status,e.review_note,e.reviewed_at,e.clip_status,e.clip_metadata,e.evidence_expires_at,(e.evidence IS NOT NULL AND e.evidence_expires_at>now()) AS has_evidence,(e.clip IS NOT NULL AND e.evidence_expires_at>now()) AS has_clip FROM proctor_events e JOIN devices d ON d.id=e.device_id JOIN sessions s ON s.id=e.session_id WHERE e.id=$1 AND e.teacher_id=$2",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      if (!row) throw issue(404, "Incident not found");
      const reviews = (
        await db.query(
          "SELECT id,status,comment,created_at FROM proctor_reviews WHERE incident_id=$1 ORDER BY created_at,id",
          [row.id],
        )
      ).rows;
      const timeline = (
        await db.query(
          "SELECT kind,detail,created_at FROM events WHERE teacher_id=$1 AND detail->>'observationId'=$2 ORDER BY created_at",
          [req.teacher, row.id],
        )
      ).rows;
      const relatedEvidence = (
        await db.query(
          "SELECT a.id,a.kind,a.captured_at,a.status,a.expires_at FROM camera_check_requests c JOIN evidence_assets a ON a.event_id=c.event_id WHERE c.source_event_id=$1 AND c.teacher_id=$2 AND a.teacher_id=$2 ORDER BY a.captured_at DESC LIMIT 24",
          [row.id, req.teacher],
        )
      ).rows;
      res.json({
        ...row,
        label: PROCTOR_CATEGORIES[row.category],
        reviews,
        timeline,
        relatedEvidence,
      });
    }),
  );
  teacher.get(
    "/events/:id/clip",
    route(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id))
        throw issue(404, "Clip not found");
      const row = (
        await db.query(
          "SELECT clip FROM proctor_events WHERE id=$1 AND teacher_id=$2 AND clip IS NOT NULL AND evidence_expires_at>now()",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      if (!row) throw issue(404, "Clip not found or expired");
      const audit = (
        await db.query(
          "SELECT session_id,device_id FROM proctor_events WHERE id=$1 AND teacher_id=$2",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      await event(
        req.teacher,
        audit.session_id,
        audit.device_id,
        "evidence_viewed",
        { observationId: req.params.id, kind: "clip" },
      );
      res
        .set({
          "Content-Type": "video/webm",
          "Cache-Control": "no-store",
          "Content-Disposition": 'inline; filename="incident.webm"',
        })
        .send(Buffer.from(row.clip));
    }),
  );
  const uploads = new Set();
  app.post(
    "/api/student/incidents/:id/clip",
    exams.studentAuth,
    express.raw({ type: "video/webm", limit: "2mb" }),
    async (req, res, next) => {
      const d = req.device;
      let acquired = false;
      let captureScope = null;
      const authorize = async () => {
        const o = online.get(d.id),
          a = await exams.assignment(req);
        if (
          !o ||
          o.cameraConsent !== a.session_id ||
          !o.clipConsent ||
          !o.snapshotConsent ||
          req.get("X-ExamOS-Camera-Grant") !== o.cameraGrant ||
          Date.now() - o.lastSeen > 8000 ||
          !(await activeAttempt(d, a.session_id))
        )
          throw issue(403, "Current camera and clip consent are required");
        const incident = (
          await db.query(
            "SELECT * FROM proctor_events WHERE id=$1 AND device_id=$2 AND teacher_id=$3 AND session_id=$4 AND clip_status IN ('pending','unavailable') AND evidence_deleted_at IS NULL AND evidence_expires_at>now()",
            [req.params.id, d.id, d.teacher_id, a.session_id],
          )
        ).rows[0];
        if (!incident)
          throw issue(
            404,
            "Pending incident not found or evidence was deleted",
          );
        return { o, a, incident };
      };
      try {
        if (
          !/^[0-9a-f-]{36}$/i.test(req.params.id) ||
          !Buffer.isBuffer(req.body) ||
          req.body.length > 2097152
        )
          throw issue(400, "A private WebM clip of at most 2 MB is required");
        console.info(
          JSON.stringify({
            stage: "clip_received_authenticated",
            deviceId: d.id,
            eventId: req.params.id,
            bytes: req.body.length,
          }),
        );
        const stored = (
          await db.query(
            "SELECT clip,clip_metadata FROM proctor_events WHERE id=$1 AND device_id=$2 AND teacher_id=$3 AND clip IS NOT NULL AND evidence_deleted_at IS NULL AND evidence_expires_at>now()",
            [req.params.id, d.id, d.teacher_id],
          )
        ).rows[0];
        if (stored) {
          if (!Buffer.from(stored.clip).equals(req.body))
            throw issue(409, "Different clip already stored for this event");
          return res.json({
            ok: true,
            metadata: stored.clip_metadata,
            duplicate: true,
          });
        }
        if (uploads.has(d.id))
          throw issue(429, "A clip upload is already being validated");
        uploads.add(d.id);
        acquired = true;
        const initial = await authorize();
        captureScope = initial;
        // Decode outside the teacher lock: withdrawal/end requests must remain immediate.
        const media = await validateClip(req.body);
        await serialize(d.teacher_id, async () => {
          const { o, a, incident } = await authorize();
          const start = new Date(req.get("X-Clip-Start")),
            end = new Date(req.get("X-Clip-End")),
            observed = new Date(incident.observed_at);
          const span = (end - start) / 1000,
            limit = o.cameraClipSeconds || 10;
          if (
            !Number.isFinite(span) ||
            span < 0.1 ||
            span > limit + 0.5 ||
            start > observed ||
            end < observed ||
            observed - start > (limit / 2 + 0.5) * 1000 ||
            end - observed > (limit / 2 + 0.5) * 1000 ||
            Math.abs(span - media.durationSeconds) > 0.75
          )
            throw issue(
              400,
              "Clip timing does not match this incident and consented duration",
            );
          const metadata = {
            ...media,
            startedAt: start.toISOString(),
            endedAt: end.toISOString(),
            preEventSeconds: Math.max(0, (observed - start) / 1000),
            postEventSeconds: Math.max(0, (end - observed) / 1000),
            requestedSeconds: limit,
          };
          await db.query(
            "WITH uploaded AS (UPDATE proctor_events SET clip=$1,clip_status='available',clip_metadata=$2 WHERE id=$3 RETURNING *) INSERT INTO evidence_assets(id,event_id,teacher_id,student_id,session_id,examination_id,kind,mime_type,storage_location,captured_at,byte_size,expires_at) SELECT $4,id,teacher_id,device_id,session_id,attempt_id,'clip','video/webm','postgresql:proctor_events/'||id||'/clip',(clip_metadata->>'startedAt')::timestamptz,octet_length(clip),evidence_expires_at FROM uploaded ON CONFLICT(event_id,kind) DO UPDATE SET byte_size=EXCLUDED.byte_size,captured_at=EXCLUDED.captured_at,expires_at=EXCLUDED.expires_at,status='available'",
            [req.body, JSON.stringify(metadata), incident.id, randomUUID()],
          );
          await event(d.teacher_id, a.session_id, d.id, "proctor_clip_ready", {
            observationId: incident.id,
            ...metadata,
          });
          notify(d.teacher_id);
          incidentNotify?.(
            d.teacher_id,
            { id: incident.id, clip_status: "available" },
            "proctor-evidence-ready",
          );
          console.info(
            JSON.stringify({
              stage: "clip_validated_stored_catalogued",
              deviceId: d.id,
              eventId: incident.id,
              bytes: req.body.length,
            }),
          );
          res.json({ ok: true, metadata });
        });
      } catch (e) {
        if (captureScope) {
          try {
            await serialize(d.teacher_id, async () => {
              const changed = await db.query(
                "UPDATE proctor_events SET clip_status='unavailable' WHERE id=$1 AND device_id=$2 AND clip_status='pending' RETURNING id",
                [captureScope.incident.id, d.id],
              );
              if (changed.rows.length) {
                await event(
                  d.teacher_id,
                  captureScope.a.session_id,
                  d.id,
                  "proctor_clip_failed",
                  {
                    observationId: captureScope.incident.id,
                    reason:
                      e.status === 403
                        ? "Consent or examination ended"
                        : e.status === 400
                          ? "Clip validation failed"
                          : "Clip could not be stored",
                  },
                );
                notify(d.teacher_id);
              }
            });
          } catch {
            /* An unavailable database cannot record its own outage; return failure without claiming storage. */
          }
        }
        next(e);
      } finally {
        if (acquired) uploads.delete(d.id);
      }
    },
  );
  app.post(
    "/api/student/stop-monitoring",
    exams.studentAuth,
    async (req, res, next) => {
      try {
        await serialize(req.device.teacher_id, async () => {
          const a = await exams.assignment(req);
          await db.query(
            "UPDATE exam_attempts SET focus_consent=false WHERE device_id=$1 AND session_id=$2",
            [req.device.id, a.session_id],
          );
          stopDevice(req.device.id, a.session_id);
          await event(
            req.device.teacher_id,
            a.session_id,
            req.device.id,
            "consent_withdrawn",
            { reason: "Student stopped all monitoring from examination page" },
          );
          notify(req.device.teacher_id);
          res.json({ ok: true });
        });
      } catch (e) {
        next(e);
      }
    },
  );
  app.post(
    "/api/student/proctor-event",
    exams.studentAuth,
    async (req, res, next) => {
      try {
        await serialize(req.device.teacher_id, async () => {
          if (!browserCategories.has(req.body.category))
            throw issue(400, "Unsupported browser observation");
          const a = await exams.assignment(req);
          const attempt = await activeAttempt(req.device, a.session_id);
          if (!attempt?.focus_consent)
            throw issue(403, "Examination-window event consent required");
          const recent = (
            await db.query(
              "SELECT id FROM proctor_events WHERE teacher_id=$1 AND device_id=$2 AND session_id=$3 AND attempt_id=$4 AND category=$5 AND received_at>now()-interval '10 seconds' ORDER BY received_at DESC LIMIT 1",
              [
                req.device.teacher_id,
                req.device.id,
                a.session_id,
                attempt.id,
                req.body.category,
              ],
            )
          ).rows[0];
          if (recent)
            return res.json({ ok: true, id: recent.id, throttled: true });
          const id = await saveObservation(req.device, a.session_id, req.body);
          res.json({ ok: true, ...id });
        });
      } catch (e) {
        next(e);
      }
    },
  );
  async function sweep() {
    await db.query(
      "UPDATE proctor_events SET evidence=NULL,clip=NULL,clip_status='expired',evidence_deleted_at=now() WHERE (evidence IS NOT NULL OR clip IS NOT NULL) AND evidence_expires_at<=now()",
    );
    await db.query(
      "UPDATE proctor_events SET clip_status='unavailable' WHERE clip_status='pending' AND received_at<now()-interval '45 seconds'",
    );
    const expired = await db.query(
      "UPDATE camera_check_requests SET status='expired',error='No consented webcam snapshot arrived before the request expired' WHERE status='queued' AND expires_at<=now() RETURNING teacher_id",
    );
    for (const r of expired.rows) notify(r.teacher_id);
    await db.query(
      "UPDATE evidence_assets a SET status='expired' FROM proctor_events e WHERE e.id=a.event_id AND a.status='available' AND LEAST(a.expires_at,e.evidence_expires_at)<=now()",
    );
  }
  return {
    async recordProhibitedApplication(device, sessionId, appName) {
      if (!(await activeAttempt(device, sessionId))) return false;
      await saveObservation(device, sessionId, {
        category: "prohibited_application",
        detail: { app: appName },
      });
      return true;
    },
    settings,
    examState,
    activeAttempt,
    clearCamera,
    attachDevice,
    sweep,
  };
}

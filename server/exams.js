import { installExamControls } from "./exam-controls.js";
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { PDFDocument, PDFDict, PDFArray, PDFName } from "pdf-lib";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const problem = (status, message) =>
  Object.assign(new Error(message), { status });
const uuid = (s) =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const fields =
  "id,title,subject,total_marks,duration_seconds,sha256,page_count,byte_count,created_at";
export function installExams({
  app,
  db,
  secret,
  auth,
  route,
  serialize,
  emit,
  stopMonitoring,
  onAttemptFinished = () => {},
}) {
  async function audit(t, p, s, d, action, detail = {}) {
    await db.query(
      "INSERT INTO paper_audit(id,teacher_id,paper_id,session_id,device_id,action,detail) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), t, p, s, d, action, JSON.stringify(detail)],
    );
    emit(t);
  }
  async function finishSession(sessionId, reason = "session_ended") {
    const r = await db.query(
      "UPDATE exam_attempts SET status=CASE WHEN status='started' THEN 'submitted' ELSE 'cancelled' END,submitted_at=now(),submission_reason=$2 WHERE session_id=$1 AND status IN ('opened','started') RETURNING *",
      [sessionId, reason],
    );
    const a = (
      await db.query("SELECT * FROM session_papers WHERE session_id=$1", [
        sessionId,
      ])
    ).rows[0];
    if (a)
      for (const x of r.rows)
        await audit(
          a.teacher_id,
          a.paper_id,
          sessionId,
          x.device_id,
          x.status === "submitted" ? "exam_submitted" : "exam_cancelled",
          { reason },
        );
  }
  async function reconcile(teacher) {
    const closed = (
      await db.query(
        "SELECT a.*,s.status FROM session_papers a JOIN sessions s ON s.id=a.session_id WHERE a.teacher_id=$1 AND (s.status='ended' OR a.closes_at<=now())",
        [teacher],
      )
    ).rows;
    for (const a of closed) {
      if (a.status === "active") {
        await db.query(
          "UPDATE sessions SET status='ended',ended_at=now() WHERE id=$1 AND status='active'",
          [a.session_id],
        );
        stopMonitoring(teacher);
        await audit(
          teacher,
          a.paper_id,
          a.session_id,
          null,
          "exam_window_closed",
          {},
        );
      }
      await finishSession(
        a.session_id,
        a.status === "active" ? "timeout" : "session_ended",
      );
    }
    const expired = (
      await db.query(
        "UPDATE exam_attempts SET status='submitted',submitted_at=now(),submission_reason='timeout' WHERE status='started' AND deadline_at<=now() AND session_id IN (SELECT session_id FROM session_papers WHERE teacher_id=$1) RETURNING *",
        [teacher],
      )
    ).rows;
    for (const x of expired) {
      onAttemptFinished(x.device_id, x.session_id);
      const a = (
        await db.query(
          "SELECT paper_id FROM session_papers WHERE session_id=$1",
          [x.session_id],
        )
      ).rows[0];
      await audit(
        teacher,
        a.paper_id,
        x.session_id,
        x.device_id,
        "exam_submitted",
        { reason: "timeout" },
      );
    }
  }
  async function studentAuth(req, res, next) {
    try {
      const token = (req.headers.authorization || "").replace(/^Bearer /, "");
      let device;
      if (token.split(".").length === 3) {
        const payload = jwt.verify(token, secret, {
          algorithms: ["HS256"],
          audience: "examos-student",
        });
        if (payload.role !== "student") throw Error();
        req.studentSession = payload.sessionId;
        device = (
          await db.query(
            "SELECT * FROM devices WHERE id=$1 AND revoked=false",
            [payload.sub],
          )
        ).rows[0];
      } else {
        device = (
          await db.query(
            "SELECT * FROM devices WHERE token_hash=$1 AND revoked=false",
            [hash(token)],
          )
        ).rows[0];
        req.deviceCredential = true;
      }
      if (!device) throw Error();
      req.device = device;
      next();
    } catch {
      res.status(401).json({
        error:
          "Student device authentication required. Open a fresh examination page from the agent.",
      });
    }
  }
  const studentRoute = (fn) => async (req, res, next) => {
    try {
      await serialize(req.device.teacher_id, () => fn(req, res));
    } catch (e) {
      next(e);
    }
  };
  async function assignment(req) {
    await reconcile(req.device.teacher_id);
    const r = await db.query(
      `SELECT a.*,s.name AS session_name,s.status AS session_status,p.title,p.subject,p.total_marks,p.duration_seconds,p.page_count FROM session_papers a JOIN sessions s ON s.id=a.session_id JOIN question_papers p ON p.id=a.paper_id WHERE a.teacher_id=$1 AND ${req.studentSession ? "a.session_id=$3" : "s.status='active'"} AND (a.all_devices=true OR EXISTS(SELECT 1 FROM paper_assignment_devices d WHERE d.session_id=a.session_id AND d.device_id=$2))`,
      req.studentSession
        ? [req.device.teacher_id, req.device.id, req.studentSession]
        : [req.device.teacher_id, req.device.id],
    );
    if (!r.rows[0])
      throw problem(
        404,
        "No question paper is assigned to this device and examination.",
      );
    return r.rows[0];
  }
  function requireOpen(a) {
    if (
      a.session_status !== "active" ||
      Date.now() >= new Date(a.closes_at).getTime()
    )
      throw problem(409, "The examination has ended.");
    if (Date.now() < new Date(a.opens_at).getTime())
      throw problem(409, "The examination has not opened yet.");
  }
  async function attempt(a, device) {
    return (
      (
        await db.query(
          "SELECT * FROM exam_attempts WHERE session_id=$1 AND device_id=$2",
          [a.session_id, device],
        )
      ).rows[0] || null
    );
  }
  async function openAttempt(a, device) {
    const r = await db.query(
      "INSERT INTO exam_attempts(id,session_id,device_id,status) VALUES ($1,$2,$3,'opened') ON CONFLICT(session_id,device_id) DO NOTHING RETURNING id",
      [randomUUID(), a.session_id, device],
    );
    if (r.rows.length)
      await audit(
        a.teacher_id,
        a.paper_id,
        a.session_id,
        device,
        "paper_opened",
        {},
      );
    return attempt(a, device);
  }
  function sendPdf(res, bytes) {
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="question-paper.pdf"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(Buffer.from(bytes));
  }
  app.post(
    "/api/student/exchange",
    rateLimit({ windowMs: 60000, limit: 30 }),
    route(async (req, res) => {
      if (typeof req.body.code !== "string")
        throw problem(400, "Launch code required");
      const r = await db.query(
        "DELETE FROM student_launches WHERE code_hash=$1 AND expires_at>now() RETURNING *",
        [hash(req.body.code)],
      );
      if (!r.rows[0])
        throw problem(
          401,
          "This examination link expired or was used. Open a fresh page from the agent.",
        );
      const launch = r.rows[0],
        device = (
          await db.query(
            "SELECT * FROM devices WHERE id=$1 AND revoked=false",
            [launch.device_id],
          )
        ).rows[0];
      if (!device) throw problem(401, "Device revoked");
      const a = (
        await db.query(
          "SELECT session_id FROM session_papers a JOIN sessions s ON s.id=a.session_id WHERE a.session_id=$1 AND s.status='active' AND a.closes_at>now() AND (a.all_devices OR EXISTS(SELECT 1 FROM paper_assignment_devices d WHERE d.session_id=a.session_id AND d.device_id=$2))",
          [launch.session_id, device.id],
        )
      ).rows[0];
      if (!a) throw problem(403, "Examination is unavailable");
      res.set("Cache-Control", "no-store").json({
        token: jwt.sign(
          { role: "student", sessionId: launch.session_id },
          secret,
          { subject: device.id, audience: "examos-student", expiresIn: "8h" },
        ),
      });
    }),
  );
  const student = express.Router();
  student.use(studentAuth);
  student.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  student.post(
    "/launch",
    studentRoute(async (req, res) => {
      if (!req.deviceCredential)
        throw problem(403, "Open the page from the enrolled desktop agent");
      const a = await assignment(req);
      if (a.session_status !== "active") throw problem(409, "Session ended");
      const code = randomBytes(32).toString("hex");
      await db.query(
        "INSERT INTO student_launches VALUES ($1,$2,$3,now()+interval '60 seconds')",
        [hash(code), req.device.id, a.session_id],
      );
      res.json({ code, expiresIn: 60 });
    }),
  );
  student.get(
    "/exam",
    studentRoute(async (req, res) => {
      const a = await assignment(req),
        x = await attempt(a, req.device.id);
      res.json({
        exam: a,
        attempt: x,
        device: { id: req.device.id, name: req.device.name },
        serverNow: new Date().toISOString(),
      });
    }),
  );
  student.get(
    "/exam/pdf",
    studentRoute(async (req, res) => {
      const a = await assignment(req);
      requireOpen(a);
      const x = await attempt(a, req.device.id);
      if (x && ["submitted", "cancelled"].includes(x.status))
        throw problem(409, "Examination already completed");
      if (x?.paused_at)
        throw problem(
          423,
          "Examination paused by the invigilator. The deadline continues.",
        );
      await openAttempt(a, req.device.id);
      const p = (
        await db.query("SELECT pdf FROM question_papers WHERE id=$1", [
          a.paper_id,
        ])
      ).rows[0];
      sendPdf(res, p.pdf);
    }),
  );
  student.post(
    "/exam/start",
    studentRoute(async (req, res) => {
      const a = await assignment(req);
      requireOpen(a);
      const x = await openAttempt(a, req.device.id);
      if (x.status === "started") return res.json(x);
      if (x.status !== "opened")
        throw problem(409, "This examination has already been completed");
      const r = await db.query(
        "UPDATE exam_attempts SET status='started',started_at=now(),deadline_at=LEAST(now()+($3 * interval '1 second'),$4::timestamptz),focus_consent=$5 WHERE session_id=$1 AND device_id=$2 AND status='opened' RETURNING *",
        [
          a.session_id,
          req.device.id,
          a.duration_seconds,
          a.closes_at,
          req.body.focusConsent === true,
        ],
      );
      await audit(
        a.teacher_id,
        a.paper_id,
        a.session_id,
        req.device.id,
        "exam_started",
        {
          deadlineAt: r.rows[0].deadline_at,
          windowEventConsent: r.rows[0].focus_consent,
          recordsTypedText: false,
        },
      );
      res.json(r.rows[0]);
    }),
  );
  function answers(body) {
    if (typeof body.answers !== "string" || body.answers.length > 12000)
      throw problem(400, "Responses must be at most 12,000 characters");
    return body.answers;
  }
  function writeVersion(body) {
    const revision = body.revision;
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof body.mutationId !== "string" ||
      !uuid(body.mutationId)
    )
      throw problem(
        400,
        "A response revision and mutation ID are required. Reload the examination page.",
      );
    return revision;
  }
  student.post(
    "/exam/save",
    studentRoute(async (req, res) => {
      const a = await assignment(req);
      requireOpen(a);
      const revision = writeVersion(req.body);
      const current = await attempt(a, req.device.id);
      if (current?.paused_at)
        throw problem(
          423,
          "Examination paused by the invigilator. The deadline continues.",
        );
      if (
        current?.last_mutation_id === req.body.mutationId &&
        current.answers !== answers(req.body)
      )
        throw problem(
          409,
          "This request ID was already used for a different response.",
        );
      if (
        current?.status === "started" &&
        new Date(current.deadline_at) > new Date() &&
        current.last_mutation_id === req.body.mutationId &&
        current.answers === answers(req.body)
      )
        return res.json({ ok: true, revision: current.answer_revision });
      const r = await db.query(
        "UPDATE exam_attempts SET answers=$3,answer_revision=answer_revision+1,last_mutation_id=$5 WHERE session_id=$1 AND device_id=$2 AND status='started' AND deadline_at>now() AND answer_revision=$4 RETURNING answer_revision",
        [
          a.session_id,
          req.device.id,
          answers(req.body),
          revision,
          req.body.mutationId,
        ],
      );
      if (!r.rows.length)
        throw problem(
          409,
          "Response conflict or examination ended. Reload the server response before continuing.",
        );
      res.json({ ok: true, revision: r.rows[0].answer_revision });
    }),
  );
  student.post(
    "/exam/submit",
    studentRoute(async (req, res) => {
      const a = await assignment(req),
        x = await attempt(a, req.device.id);
      if (x?.status === "submitted") return res.json(x);
      if (x?.paused_at)
        throw problem(
          423,
          "Examination paused by the invigilator. The deadline continues.",
        );
      requireOpen(a);
      const revision = writeVersion(req.body);
      const r = await db.query(
        "UPDATE exam_attempts SET status='submitted',submitted_at=now(),submission_reason='manual',answers=$3,answer_revision=answer_revision+1,last_mutation_id=$5 WHERE session_id=$1 AND device_id=$2 AND status='started' AND deadline_at>now() AND answer_revision=$4 RETURNING *",
        [
          a.session_id,
          req.device.id,
          answers(req.body),
          revision,
          req.body.mutationId,
        ],
      );
      if (!r.rows.length)
        throw problem(
          409,
          "Start the examination before submitting, within its allowed time",
        );
      await audit(
        a.teacher_id,
        a.paper_id,
        a.session_id,
        req.device.id,
        "exam_submitted",
        { reason: "manual" },
      );
      onAttemptFinished(req.device.id, a.session_id);
      res.json(r.rows[0]);
    }),
  );
  app.use("/api/student", student);
  const teacher = express.Router();
  teacher.use((req, res, next) => {
    if (
      !/^\/(?:papers(?:\/|$)|paper-audit(?:\/|$)|sessions\/[^/]+\/(?:paper|exam-status|attempts)(?:\/|$))/.test(
        req.path,
      )
    )
      return next("router");
    auth(req, res, next);
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
      fields: 4,
      parts: 5,
      fieldSize: 1024,
      fieldNameSize: 80,
      fieldArrayIndexLimit: 20,
    },
  }).single("pdf");
  teacher.get(
    "/papers",
    route(async (req, res) =>
      res.json(
        (
          await db.query(
            `SELECT ${fields} FROM question_papers WHERE teacher_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
            [req.teacher],
          )
        ).rows,
      ),
    ),
  );
  teacher.post(
    "/papers",
    upload,
    route(async (req, res) => {
      const f = req.file,
        { title, subject, totalMarks, durationMinutes } = req.body;
      const marks = Number(totalMarks),
        duration = Number(durationMinutes);
      if (
        !f ||
        f.mimetype !== "application/pdf" ||
        !f.originalname.toLowerCase().endsWith(".pdf") ||
        f.buffer.subarray(0, 5).toString() !== "%PDF-" ||
        !/%%EOF\s*$/.test(f.buffer.subarray(-1024).toString("latin1"))
      )
        throw problem(400, "Upload a valid PDF file (maximum 10 MB).");
      if (
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 150 ||
        typeof subject !== "string" ||
        !subject.trim() ||
        subject.length > 120 ||
        !Number.isInteger(marks) ||
        marks < 1 ||
        marks > 10000 ||
        !Number.isInteger(duration) ||
        duration < 1 ||
        duration > 1440
      )
        throw problem(
          400,
          "Provide title, subject, marks (1–10,000), and duration (1–1,440 whole minutes).",
        );
      let doc;
      try {
        doc = await PDFDocument.load(f.buffer, {
          ignoreEncryption: false,
          throwOnInvalidObject: true,
        });
        if (
          doc.isEncrypted ||
          doc.getPageCount() < 1 ||
          doc.getPageCount() > 500
        )
          throw Error();
        const blocked = new Set([
          "JavaScript",
          "JS",
          "Launch",
          "EmbeddedFile",
          "EmbeddedFiles",
          "RichMedia",
          "XFA",
          "OpenAction",
          "AA",
          "SubmitForm",
          "ImportData",
        ]);
        let nodes = 0;
        function inspect(o, depth = 0) {
          if (++nodes > 100000 || depth > 100) throw Error();
          if (o instanceof PDFName && blocked.has(o.decodeText()))
            throw Error();
          if (o instanceof PDFDict)
            for (const [key, value] of o.entries()) {
              if (blocked.has(key.decodeText())) throw Error();
              inspect(value, depth + 1);
            }
          if (o instanceof PDFArray)
            for (let i = 0; i < o.size(); i++) inspect(o.get(i), depth + 1);
        }
        for (const [, o] of doc.context.enumerateIndirectObjects()) inspect(o);
      } catch {
        throw problem(
          400,
          "PDF could not be safely read. Encrypted, malformed, active-content or embedded-file PDFs are not accepted.",
        );
      }
      const id = randomUUID();
      await db.query(
        "INSERT INTO question_papers(id,teacher_id,title,subject,total_marks,duration_seconds,pdf,sha256,page_count,byte_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          req.teacher,
          title.trim(),
          subject.trim(),
          marks,
          duration * 60,
          f.buffer,
          hash(f.buffer),
          doc.getPageCount(),
          f.size,
        ],
      );
      await audit(req.teacher, id, null, null, "paper_uploaded", {
        title: title.trim(),
        sha256: hash(f.buffer),
        bytes: f.size,
      });
      res.status(201).json({ id });
    }),
  );
  teacher.get(
    "/papers/:id/pdf",
    route(async (req, res) => {
      if (!uuid(req.params.id)) throw problem(404, "Paper not found");
      const p = (
        await db.query(
          "SELECT pdf FROM question_papers WHERE id=$1 AND teacher_id=$2 AND deleted_at IS NULL",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      if (!p) throw problem(404, "Paper not found");
      sendPdf(res, p.pdf);
    }),
  );
  teacher.post(
    "/papers/:id/delete",
    route(async (req, res) => {
      if (!uuid(req.params.id)) throw problem(404, "Paper not found");
      if (
        (
          await db.query(
            "SELECT 1 FROM session_papers a JOIN sessions s ON s.id=a.session_id WHERE a.paper_id=$1 AND a.teacher_id=$2 AND s.status='active'",
            [req.params.id, req.teacher],
          )
        ).rows.length
      )
        throw problem(409, "End sessions using this paper before deleting it.");
      const r = await db.query(
        "UPDATE question_papers SET deleted_at=now() WHERE id=$1 AND teacher_id=$2 AND deleted_at IS NULL RETURNING id",
        [req.params.id, req.teacher],
      );
      if (!r.rows.length) throw problem(404, "Paper not found");
      await audit(req.teacher, req.params.id, null, null, "paper_deleted", {});
      res.json({ ok: true });
    }),
  );
  teacher.post(
    "/sessions/:id/paper",
    route(async (req, res) => {
      const { paperId, deviceIds = null, opensAt, closesAt } = req.body;
      if (!uuid(req.params.id) || !uuid(paperId))
        throw problem(400, "Choose a valid examination and paper");
      const p = (
        await db.query(
          "SELECT * FROM question_papers WHERE id=$1 AND teacher_id=$2 AND deleted_at IS NULL",
          [paperId, req.teacher],
        )
      ).rows[0];
      const s = (
        await db.query(
          "SELECT * FROM sessions WHERE id=$1 AND teacher_id=$2 AND status='active'",
          [req.params.id, req.teacher],
        )
      ).rows[0];
      if (!p || !s) throw problem(404, "Active session or paper not found");
      if (
        (
          await db.query(
            "SELECT 1 FROM exam_attempts WHERE session_id=$1 LIMIT 1",
            [s.id],
          )
        ).rows.length
      )
        throw problem(
          409,
          "Paper assignment cannot change after a student has opened it",
        );
      const open = opensAt ? new Date(opensAt) : new Date(),
        close = closesAt
          ? new Date(closesAt)
          : new Date(open.getTime() + p.duration_seconds * 1000);
      if (
        !Number.isFinite(open.getTime()) ||
        !Number.isFinite(close.getTime()) ||
        close <= open ||
        close <= new Date() ||
        close - open > 86400000
      )
        throw problem(
          400,
          "Choose a future closing time after opening (maximum 24-hour window)",
        );
      if (deviceIds !== null) {
        if (
          !Array.isArray(deviceIds) ||
          !deviceIds.length ||
          deviceIds.length > 500 ||
          deviceIds.some((x) => !uuid(x))
        )
          throw problem(400, "Select at least one valid enrolled device");
        for (const id of deviceIds)
          if (
            !(
              await db.query(
                "SELECT 1 FROM devices WHERE id=$1 AND teacher_id=$2 AND revoked=false",
                [id, req.teacher],
              )
            ).rows.length
          )
            throw problem(403, "Device does not belong to this teacher");
      }
      await db.query(
        "INSERT INTO session_papers(session_id,paper_id,teacher_id,opens_at,closes_at,all_devices) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id) DO UPDATE SET paper_id=EXCLUDED.paper_id,opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,all_devices=EXCLUDED.all_devices,assigned_at=now()",
        [
          s.id,
          p.id,
          req.teacher,
          open.toISOString(),
          close.toISOString(),
          deviceIds === null,
        ],
      );
      await db.query(
        "DELETE FROM paper_assignment_devices WHERE session_id=$1",
        [s.id],
      );
      if (deviceIds)
        for (const id of new Set(deviceIds))
          await db.query(
            "INSERT INTO paper_assignment_devices VALUES ($1,$2)",
            [s.id, id],
          );
      await audit(req.teacher, p.id, s.id, null, "paper_assigned", {
        opensAt: open,
        closesAt: close,
        deviceIds:
          deviceIds || "all enrolled devices, including later enrollments",
      });
      res.json({ ok: true });
    }),
  );
  installExamControls({
    teacher,
    db,
    route,
    emit,
    reconcile,
    onAttemptFinished,
  });
  async function progress(teacher, sessionId) {
    await reconcile(teacher);
    const a = (
      await db.query(
        "SELECT a.*,p.title,p.subject,p.total_marks,p.duration_seconds FROM session_papers a JOIN question_papers p ON p.id=a.paper_id WHERE a.teacher_id=$1 AND a.session_id=$2",
        [teacher, sessionId],
      )
    ).rows[0];
    if (!a) return null;
    const students = (
      await db.query(
        `SELECT d.id AS device_id,d.name,d.revoked,x.id AS attempt_id,x.status,x.paused_at,x.control_reason,x.opened_at,x.started_at,x.deadline_at,x.submitted_at,x.submission_reason,x.answers,
 (SELECT count(*)::integer FROM proctor_events e WHERE e.attempt_id=x.id AND e.teacher_id=$2 AND e.review_status='pending' AND e.category NOT IN ('camera_check','camera_unavailable','camera_disconnected')) AS pending_incidents,
 (SELECT count(*)::integer FROM events e WHERE e.session_id=$1 AND e.device_id=d.id AND e.teacher_id=$2 AND e.kind='rule_alert' AND e.review IS NULL) AS pending_app_alerts
 FROM devices d LEFT JOIN exam_attempts x ON x.device_id=d.id AND x.session_id=$1 WHERE d.teacher_id=$2 AND (EXISTS(SELECT 1 FROM session_papers a WHERE a.session_id=$1 AND a.all_devices) OR EXISTS(SELECT 1 FROM paper_assignment_devices z WHERE z.session_id=$1 AND z.device_id=d.id)) ORDER BY d.name`,
        [sessionId, teacher],
      )
    ).rows.map((x) => ({
      ...x,
      status: x.status || "not_opened",
      remainingSeconds:
        x.status === "started"
          ? Math.max(
              0,
              Math.ceil((new Date(x.deadline_at) - Date.now()) / 1000),
            )
          : null,
    }));
    const controls = (
      await db.query(
        "SELECT c.*,t.email AS actor_email FROM exam_controls c JOIN teachers t ON t.id=c.teacher_id WHERE c.teacher_id=$1 AND c.session_id=$2 ORDER BY c.created_at DESC LIMIT 200",
        [teacher, sessionId],
      )
    ).rows;
    return {
      assignment: a,
      students,
      controls,
      serverNow: new Date().toISOString(),
    };
  }
  teacher.get(
    "/sessions/:id/exam-status",
    route(async (req, res) => {
      if (!uuid(req.params.id)) throw problem(404, "Session not found");
      if (
        !(
          await db.query(
            "SELECT 1 FROM sessions WHERE id=$1 AND teacher_id=$2",
            [req.params.id, req.teacher],
          )
        ).rows.length
      )
        throw problem(404, "Session not found");
      res.json(
        await serialize(req.teacher, () =>
          progress(req.teacher, req.params.id),
        ),
      );
    }),
  );
  teacher.get(
    "/paper-audit",
    route(async (req, res) =>
      res.json(
        (
          await db.query(
            "SELECT a.*,p.title,d.name AS device_name FROM paper_audit a LEFT JOIN question_papers p ON p.id=a.paper_id LEFT JOIN devices d ON d.id=a.device_id WHERE a.teacher_id=$1 ORDER BY created_at DESC LIMIT 1000",
            [req.teacher],
          )
        ).rows,
      ),
    ),
  );
  app.use("/api", teacher);
  async function tick() {
    const ts = (
      await db.query(
        "SELECT DISTINCT a.teacher_id FROM session_papers a JOIN sessions s ON s.id=a.session_id WHERE s.status='active' OR EXISTS(SELECT 1 FROM exam_attempts x WHERE x.session_id=a.session_id AND x.status IN ('opened','started'))",
      )
    ).rows;
    for (const t of ts)
      await serialize(t.teacher_id, () => reconcile(t.teacher_id));
  }
  return { finishSession, tick, studentAuth, assignment };
}

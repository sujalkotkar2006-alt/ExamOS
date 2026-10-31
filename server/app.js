import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installExams } from "./exams.js";
import { enrollmentHandlers } from "./enrollment.js";
import { installProctoring } from "./proctoring.js";
import { originAllowed } from "./deployment.js";
export const hash = (s) => createHash("sha256").update(s).digest("hex");
export function createApp(db, secret, { dashboardDirectory = fileURLToPath(new URL("../dashboard/dist", import.meta.url)), deployment = {} } = {}) {
  if (!secret || secret.length < 32)
    throw Error("JWT_SECRET must contain at least 32 characters");
  const app = express();
  if (deployment.behindProxy) app.set("trust proxy", 1);
  app.use((req, res, next) => {
    if (deployment.behindProxy && !req.secure && req.path !== "/api/health")
      return res.status(400).json({ error: "HTTPS is required" });
    const origin = req.get("Origin");
    if (!originAllowed(origin, deployment, `${req.protocol}://${req.get("host")}`))
      return res.status(403).json({ error: "Browser origin is not allowed" });
    if (origin) {
      res.vary("Origin");
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
      res.set("Access-Control-Expose-Headers", "Content-Disposition");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "blob:"],
          "media-src": ["'self'", "blob:"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const online = new Map(),
    locks = new Map();
  let io;
  let ticking=false;
  // Serialize session transitions and device messages per teacher, including across sockets.
  const serialize = (teacher, fn) => {
    const previous = locks.get(teacher) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    locks.set(teacher, next);
    next
      .finally(() => {
        if (locks.get(teacher) === next) locks.delete(teacher);
      })
      .catch(() => {});
    return next;
  };
  const auth = (req, res, next) => {
    try {
      const payload = jwt.verify(
        (req.headers.authorization || "").replace(/^Bearer /, ""),
        secret,
        { algorithms: ["HS256"] },
      );
      if (payload.role && payload.role !== "teacher")
        throw Error("Teacher authentication required");
      req.teacher = payload.sub;
      next();
    } catch {
      res.status(401).json({ error: "Sign in required" });
    }
  };
  const route = (fn) => async (req, res, next) => {
    try {
      if (req.teacher && ["POST", "DELETE"].includes(req.method))
        await serialize(req.teacher, () => fn(req, res));
      else await fn(req, res);
    } catch (e) {
      next(e);
    }
  };
  const emit = (t) => io?.to("teacher:" + t).emit("refresh");
  const enrollment = enrollmentHandlers({
    db,
    emit,
    onEnrolled: (teacher, data) =>
      io?.to("teacher:" + teacher).emit("device-enrolled", data),
  });
  async function event(t, s, d, kind, detail) {
    await db.query(
      "INSERT INTO events(id,teacher_id,session_id,device_id,kind,detail) VALUES ($1,$2,$3,$4,$5,$6)",
      [randomUUID(), t, s, d, kind, JSON.stringify(detail)],
    );
    emit(t);
  }
  const active = async (t) =>
    (
      await db.query(
        "SELECT * FROM sessions WHERE teacher_id=$1 AND status='active' AND NOT EXISTS(SELECT 1 FROM session_papers a WHERE a.session_id=sessions.id AND a.closes_at<=now())",
        [t],
      )
    ).rows[0];
  const stopMonitoring = (teacher) => {
    for (const o of online.values())
      if (o.teacher === teacher) {
        o.consented = null;
        o.app = null;
        o.cameraConsent = null;
        o.snapshotConsent = false;
        o.clipConsent = false;
        o.cameraGrant = null;
        o.cameraStatus = "off";
        o.lockdownMode = "closed";
      }
    io?.to("devices:" + teacher).emit("session", null);
    io?.to("teacher:" + teacher).emit("clear-previews");
    emit(teacher);
  };
  const exams = installExams({
    app,
    db,
    secret,
    auth,
    route,
    serialize,
    emit,
    stopMonitoring,
    monitoringReady: (device, sessionId) => {
      const o = online.get(device.id);
      return !!(o && o.teacher === device.teacher_id && o.socket.connected &&
        o.consented === sessionId && o.screenSampleSession === sessionId &&
        Date.now() - o.lastSeen <= 8000 && Date.now() - o.lastSample <= 8000);
    },
    onAttemptFinished: (deviceId, sessionId) => {
      const o = online.get(deviceId);
      if (!o) return;
      o.consented = null;
      o.cameraConsent = null;
      o.snapshotConsent = false;
      o.clipConsent = false;
      o.cameraGrant = null;
      o.cameraStatus = "off";
      o.lockdownMode = "closed";
      o.app = null;
      o.socket.emit("exam-finished", { sessionId });
      io?.to("teacher:" + o.teacher).emit("monitoring-stopped", {
        deviceId,
        sessionId,
        reason: "Student examination completed",
      });
      emit(o.teacher);
      io?.to("teacher:" + o.teacher).emit("proctor-refresh");
    },
  });
  const proctor = installProctoring({
    app,
    db,
    auth,
    route,
    serialize,
    online,
    exams,
    stopDevice: (deviceId, sessionId) => {
      const o = online.get(deviceId);
      if (!o) return;
      o.consented = null;
      o.app = null;
      o.cameraConsent = null;
      o.snapshotConsent = false;
      o.clipConsent = false;
      o.cameraGrant = null;
      o.cameraStatus = "off";
      o.lockdownMode = "closed";
      o.socket.emit("stop-monitoring", { sessionId });
      io?.to("teacher:" + o.teacher).emit("monitoring-stopped", {
        deviceId,
        sessionId,
      });
    },
    event,
    notify: (teacher) => io?.to("teacher:" + teacher).emit("proctor-refresh"),
    incidentNotify: (teacher, incident, type = "proctor-incident") =>
      io?.to("teacher:" + teacher).emit(type, incident),
  });
  // Public liveness only. Keep-alive probes must not consume database compute.
  app.get("/healthz", (req, res) => res.set("Cache-Control", "no-store").json({ ok: true }));
  app.get(
    "/api/health",
    route(async (req, res) => {
      await db.query("SELECT 1");
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/login",
    rateLimit({ windowMs: 60000, limit: 10 }),
    route(async (req, res) => {
      const { email, password } = req.body;
      if (typeof email !== "string" || typeof password !== "string")
        return res.status(400).json({ error: "Credentials required" });
      const t = (
        await db.query("SELECT * FROM teachers WHERE email=$1", [
          email.toLowerCase().trim(),
        ])
      ).rows[0];
      if (!t || !(await bcrypt.compare(password, t.password_hash)))
        return res.status(401).json({ error: "Invalid credentials" });
      res.json({
        token: jwt.sign({ role: "teacher" }, secret, {
          subject: t.id,
          expiresIn: "8h",
        }),
      });
    }),
  );
  app.post(
    "/api/enroll",
    rateLimit({
      windowMs: 60000,
      limit: 10,
      message: {
        code: "ENROLLMENT_RATE_LIMIT",
        error:
          "Too many enrollment attempts. Wait one minute before trying again; a successful enrollment can reconnect with its saved credential.",
      },
    }),
    route(enrollment.enroll),
  );
  app.use("/api", auth);
  app.post("/api/enrollment", route(enrollment.issue));
  app.get(
    "/api/state",
    route(async (req, res) => {
      const sessions = (
        await db.query(
          "SELECT * FROM sessions WHERE teacher_id=$1 ORDER BY started_at DESC",
          [req.teacher],
        )
      ).rows;
      const devices = (
        await db.query(
          "SELECT id,name,revoked FROM devices WHERE teacher_id=$1",
          [req.teacher],
        )
      ).rows.map((d) => {
        const o = online.get(d.id);
        return {
          ...d,
          online: !!o,
          consented: !!o?.consented,
          app: o?.app || null,
          lastSeen: o?.lastSeen || null,
        };
      });
      res.json({ sessions, devices });
    }),
  );
  app.post(
    "/api/sessions",
    route(async (req, res) => {
      const { name, allowedApps = [] } = req.body;
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 120 ||
        !Array.isArray(allowedApps) ||
        allowedApps.length > 50 ||
        allowedApps.some(
          (a) => typeof a !== "string" || !a.trim() || a.length > 80,
        )
      )
        return res
          .status(400)
          .json({ error: "Enter a session name and valid process names" });
      if (await active(req.teacher))
        return res.status(409).json({ error: "End the active session first" });
      const id = randomUUID();
      await db.query(
        "INSERT INTO sessions(id,teacher_id,name,allowed_apps,status) VALUES ($1,$2,$3,$4,'active')",
        [
          id,
          req.teacher,
          name.trim(),
          JSON.stringify(allowedApps.map((a) => a.toLowerCase().trim())),
        ],
      );
      io.to("devices:" + req.teacher).emit(
        "session",
        await active(req.teacher),
      );
      emit(req.teacher);
      res.json({ id });
    }),
  );
  app.post(
    "/api/sessions/:id/end",
    route(async (req, res) => {
      const r = await db.query(
        "UPDATE sessions SET status='ended',ended_at=now() WHERE id=$1 AND teacher_id=$2 AND status='active' RETURNING id",
        [req.params.id, req.teacher],
      );
      if (!r.rows.length)
        return res.status(404).json({ error: "Active session not found" });
      await exams.finishSession(req.params.id);
      stopMonitoring(req.teacher);
      for (const o of online.values())
        if (o.teacher === req.teacher) {
          o.consented = null;
          o.app = null;
        }
      io.to("devices:" + req.teacher).emit("session", null);
      io.to("teacher:" + req.teacher).emit("clear-previews");
      emit(req.teacher);
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/sessions/:id/events",
    route(async (req, res) => {
      res.json(
        (
          await db.query(
            "SELECT e.*,d.name AS device_name FROM events e LEFT JOIN devices d ON d.id=e.device_id WHERE e.session_id=$1 AND e.teacher_id=$2 ORDER BY e.created_at DESC LIMIT 1000",
            [req.params.id, req.teacher],
          )
        ).rows,
      );
    }),
  );
  app.post(
    "/api/events/:id/review",
    route(async (req, res) => {
      if (
        typeof req.body.review !== "string" ||
        !req.body.review.trim() ||
        req.body.review.length > 2000
      )
        return res
          .status(400)
          .json({ error: "Review must contain 1–2000 characters" });
      const r = await db.query(
        "UPDATE events SET review=$1,reviewed_at=now() WHERE id=$2 AND teacher_id=$3 RETURNING id",
        [req.body.review, req.params.id, req.teacher],
      );
      if (!r.rows.length)
        return res.status(404).json({ error: "Event not found" });
      emit(req.teacher);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/devices/:id/revoke",
    route(async (req, res) => {
      const r = await db.query(
        "UPDATE devices SET revoked=true WHERE id=$1 AND teacher_id=$2 RETURNING id",
        [req.params.id, req.teacher],
      );
      if (!r.rows.length)
        return res.status(404).json({ error: "Device not found" });
      online.get(req.params.id)?.socket.disconnect(true);
      emit(req.teacher);
      res.json({ ok: true });
    }),
  );
  app.use(
    express.static(dashboardDirectory),
  );
  app.get("/", (req, res) =>
    res.sendFile(
      path.join(dashboardDirectory, "index.html"),
    ),
  );
  app.get("/student", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (deployment.appOrigin && deployment.appOrigin !== `${req.protocol}://${req.get("host")}`)
      return res.redirect(302, deployment.appOrigin + "/student");
    res.sendFile(path.join(dashboardDirectory, "index.html"));
  });
  app.use((err, req, res, next) => {
    console.error(err.message);
    res
      .status(
        err.status ||
          (err.code?.startsWith("LIMIT_")
            ? 400
            : err.code === "23505"
              ? 409
              : 500),
      )
      .json({
        error: err.status
          ? err.message
          : err.code?.startsWith("LIMIT_")
            ? "PDF upload exceeds allowed limits (one PDF, maximum 10 MB)."
            : err.code === "23505"
              ? "Conflicting active session"
              : "Request failed",
      });
  });
  function attach(server) {
    const examTimer = setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try {
        await exams.tick();
        for (const [deviceId, o] of online) {
          if (Date.now() - o.lastSeen > 8000 && !o.leaseExpiredReported) {
            await serialize(o.teacher, async () => {
              if (online.get(deviceId)!==o || Date.now() - o.lastSeen <= 8000) return;
              o.leaseExpiredReported = true;
              await db.query(
                "UPDATE exam_attempts SET focus_consent=false WHERE device_id=$1 AND status='started'",
                [deviceId],
              );
              o.consented = null;
              o.app = null;
              proctor.clearCamera(o);
              io.to("teacher:" + o.teacher).emit("monitoring-stopped", {
                deviceId,
                reason: "Heartbeat lease expired; technical status only",
              });
              io.to("teacher:" + o.teacher).emit("proctor-refresh");
              const s = await active(o.teacher);
              if (s)
                await event(
                  o.teacher,
                  s.id,
                  deviceId,
                  "monitoring_lease_expired",
                  {
                    reason: "No current heartbeat; no misconduct determination",
                  },
                );
            });
          }
        }
        await proctor.sweep();
      } catch (e) {
        console.error("Exam timer:", e.message);
      } finally {
        ticking = false;
      }
    }, 1000);
    examTimer.unref();
    server.on("close", () => clearInterval(examTimer));
    io = new Server(server, {
      cors: {
        origin: (origin, callback) => callback(null, !origin || [deployment.appOrigin, deployment.backendOrigin].includes(origin)),
        methods: ["GET", "POST"],
      },
      allowRequest: (req, callback) => {
        const protocol = req.socket.encrypted ? "https" : "http";
        const secure = protocol === "https" || (deployment.behindProxy && req.headers["x-forwarded-proto"] === "https");
        callback(null, (!deployment.behindProxy || secure) && originAllowed(req.headers.origin, deployment, `${protocol}://${req.headers.host}`));
      },
      maxHttpBufferSize: 180000,
      pingTimeout: 6000,
      pingInterval: 4000,
    });
    io.use(async (socket, next) => {
      try {
        const a = socket.handshake.auth;
        if (a.role === "teacher") {
          const payload = jwt.verify(a.token, secret, {
            algorithms: ["HS256"],
          });
          if (payload.role && payload.role !== "teacher") throw Error();
          socket.teacher = payload.sub;
          socket.expires = jwt.decode(a.token).exp;
        } else {
          if (typeof a.token !== "string") throw Error();
          socket.device = (
            await db.query(
              "SELECT * FROM devices WHERE token_hash=$1 AND revoked=false",
              [hash(a.token)],
            )
          ).rows[0];
          if (!socket.device) throw Error();
        }
        next();
      } catch {
        next(Error("Unauthorized"));
      }
    });
    io.on("connection", (socket) => {
      if (socket.teacher) {
        socket.join("teacher:" + socket.teacher);
        const timer = setTimeout(
          () => socket.disconnect(true),
          Math.max(0, socket.expires * 1000 - Date.now()),
        );
        socket.on("disconnect", () => clearTimeout(timer));
        return;
      }
      const d = socket.device;
      online.get(d.id)?.socket.disconnect(true);
      const o = {
        socket,
        teacher: d.teacher_id,
        consented: null,
        lastSeen: Date.now(),
        app: null,
        lastSample: 0,
        lastAlert: 0,
      };
      online.set(d.id, o);
      socket.join("devices:" + d.teacher_id);
      // Serialize device messages so end/consent/sample ordering cannot overtake one another.
      let queue = Promise.resolve();
      let pending = 0;
      const on = (name, fn) =>
        socket.on(name, (p, ack) => {
          if (pending >= 8) return socket.disconnect(true);
          pending++;
          queue = queue
            .then(() =>
              serialize(d.teacher_id, () =>
                socket.connected && online.get(d.id) === o
                  ? fn(p, ack)
                  : undefined,
              ),
            )
            .catch((e) => {
              console.error(e.message);
              if (typeof ack === "function")
                ack({
                  error: e.status ? e.message : "Request failed",
                  status: e.status || 503,
                  retryable: !e.status || e.status >= 500 || e.status === 429,
                });
            })
            .finally(() => pending--);
        });
      on("heartbeat", async (_, ack) => {
        if (Date.now() - o.lastSeen > 8000) {
          o.consented = null;
          proctor.clearCamera(o);
        }
        o.lastSeen = Date.now();
        o.leaseExpiredReported = false;
        const s = await active(d.teacher_id);
        if (o.consented !== s?.id) {
          o.consented = null;
          o.app = null;
        }
        if (o.cameraConsent !== s?.id)
          proctor.clearCamera(
            o,
            s && ["unavailable", "disconnected"].includes(o.cameraStatus)
              ? o.cameraStatus
              : "off",
          );
        const exam = await proctor.examState(d, s?.id);
        if (exam && ["submitted", "cancelled"].includes(exam.status)) {
          o.consented = null;
          o.app = null;
          proctor.clearCamera(o);
        }
        if (typeof ack === "function")
          ack({
            session: s || null,
            serverNow: new Date().toISOString(),
            leaseSeconds: 8,
            screenConsented: !!s && o.consented===s.id,
            cameraConsented: !!s && o.cameraConsent===s.id,
            exam,
            proctoring: await proctor.settings(d.teacher_id),
          });
      });
      proctor.attachDevice({ on, d, o, active });
      on("consent", async (p, ack) => {
        const s = await active(d.teacher_id);
        if (!s || p?.sessionId !== s.id || typeof p.accept !== "boolean")
          return (
            typeof ack === "function" && ack({ error: "Session unavailable" })
          );
        const attempt = await proctor.examState(d, s.id);
        if (
          p.accept &&
          attempt &&
          ["submitted", "cancelled"].includes(attempt.status)
        )
          return ack?.({
            error: "Examination completed; monitoring cannot restart",
          });
        o.consented = p.accept ? s.id : null;
        o.screenSampleSession = null;
        o.lastSample = 0;
        if (!p.accept) {
          proctor.clearCamera(o);
          o.lockdownMode = "closed";
          await db.query(
            "UPDATE exam_attempts SET focus_consent=false WHERE device_id=$1 AND session_id=$2",
            [d.id, s.id],
          );
          io?.to("teacher:" + d.teacher_id).emit("proctor-refresh");
        }
        o.app = null;
        const stopReasons = {
          student_stop: "Student stopped monitoring",
          keyboard_stop: "Student stopped monitoring using Escape",
          minimized: "Student minimized the monitoring window",
          window_closed: "Student closed the monitoring window",
          lease_expired: "Monitoring stopped because the server lease expired",
        };
        const detail = p.accept
          ? {}
          : {
              reason: Object.hasOwn(stopReasons, p.reason)
                ? stopReasons[p.reason]
                : "Student stopped monitoring",
            };
        if (!p.accept) {
          io.to("teacher:" + d.teacher_id).emit("monitoring-stopped", {
            deviceId: d.id,
            sessionId: s.id,
            reason: detail.reason,
          });
          emit(d.teacher_id);
        }
        await event(
          d.teacher_id,
          s.id,
          d.id,
          p.accept ? "consent_granted" : "consent_withdrawn",
          detail,
        );
        if (typeof ack === "function") ack({ ok: true });
      });
      on("sample", async (p, ack) => {
        const s = await active(d.teacher_id);
        const attempt = await proctor.examState(d, s?.id);
        const completed =
          attempt &&
          (["submitted", "cancelled"].includes(attempt.status) ||
            (attempt.status === "started" &&
              new Date(attempt.deadline_at) <= new Date()));
        if (
          completed ||
          !s ||
          o.consented !== s.id ||
          p?.sessionId !== s.id ||
          Date.now() - o.lastSeen > 8000
        )
          return (
            typeof ack === "function" &&
            ack({ error: "Monitoring not authorized" })
          );
        if (Date.now() - o.lastSample < 1500) return;
        if (
          typeof p.app !== "string" ||
          p.app.length > 120 ||
          typeof p.jpeg !== "string" ||
          p.jpeg.length > 160000 ||
          !/^\/9j\/[A-Za-z0-9+/=]+$/.test(p.jpeg)
        )
          return;
        o.lastSample = Date.now();
        o.screenSampleSession = s.id;
        const changed = o.app !== p.app;
        o.app = p.app;
        const name = p.app.toLowerCase();
        if (changed)
          await event(
            d.teacher_id,
            s.id,
            d.id,
            p.app === "[unavailable]" ? "telemetry_unavailable" : "application",
            { app: p.app },
          );
        if (
          p.app !== "[unavailable]" &&
          s.allowed_apps.length &&
          !s.allowed_apps.includes(name) &&
          Date.now() - o.lastAlert > 30000
        ) {
          o.lastAlert = Date.now();
          if (!(await proctor.recordProhibitedApplication(d, s.id, p.app)))
            await event(d.teacher_id, s.id, d.id, "rule_alert", {
              app: p.app,
              reason:
                "Application outside allowed list; teacher review required",
            });
        } // Re-check session after awaited writes before forwarding pixels.
        if ((await active(d.teacher_id))?.id === s.id && o.consented === s.id && socket.connected && online.get(d.id)===o && Date.now()-o.lastSeen<=8000)
          io.to("teacher:" + d.teacher_id).emit("preview", {
            deviceId: d.id,
            sessionId: s.id,
            jpeg: p.jpeg,
            app: p.app,
            at: Date.now(),
          });
        if (typeof ack === "function") ack({ ok: true });
      });
      socket.on("disconnect", () => {
        if (online.get(d.id) !== o) return;
        o.consented=null;
        o.app=null;
        proctor.clearCamera(o);
        online.delete(d.id);
        io.to("teacher:" + d.teacher_id).emit("proctor-refresh");
        io.to("teacher:" + d.teacher_id).emit("device-offline", d.id);
        serialize(d.teacher_id, async () => {
          if(online.has(d.id)) return;
          const s=await active(d.teacher_id);
          await db.query("UPDATE camera_check_requests SET status='failed',error='Student agent disconnected before capture' WHERE device_id=$1 AND status='queued'",[d.id]);
          await db.query("UPDATE exam_attempts SET focus_consent=false WHERE device_id=$1 AND status='started'",[d.id]);
          if(s) await event(d.teacher_id,s.id,d.id,'connection_lost',{reason:'Connection lost; no misconduct determination'});
        }).catch(console.error);
        emit(d.teacher_id);
      });
      active(d.teacher_id)
        .then((s) => socket.emit("session", s || null))
        .catch(console.error);
      emit(d.teacher_id);
    });
    return io;
  }
  async function drain() {
    while(locks.size || ticking) {
      await Promise.allSettled([...locks.values()]);
      if(ticking) await new Promise(r=>setTimeout(r,5));
    }
  }
  return { app, attach, online, drain };
}

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {testDatabase} from "./test-database.mjs";
import { randomUUID, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PGlite } from "@electric-sql/pglite";
import http from "node:http";
import { migrate } from "../server/db.js";
import { createApp } from "../server/app.js";
export async function actualPaper() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = [
    "ExamOS Mathematics Examination",
    "Subject: Algebra | Total marks: 20 | Duration: 1 minute",
    "",
    "1. Solve 2x + 7 = 19. Show your working. (10 marks)",
    "",
    "2. Find the area of a rectangle with sides 8 cm and 5 cm. (10 marks)",
    "",
    "Enter your responses on the student examination page.",
  ];
  lines.forEach((s, i) =>
    page.drawText(s, {
      x: 45,
      y: 780 - i * 35,
      size: i === 0 ? 20 : 12,
      font,
      color: rgb(0.1, 0.2, 0.15),
    }),
  );
  const bytes = Buffer.from(await doc.save());
  return bytes;
}
export async function fixture({ pollingOnly = false, persistentDirectory = null } = {}) {
  let db = await testDatabase({persistentDirectory});
  await migrate(db);
  await migrate(db);
  const teacher = randomUUID(),
    other = randomUUID(),
    password = randomBytes(20).toString("hex");
  await db.query("INSERT INTO teachers VALUES ($1,$2,$3),($4,$5,$3)", [
    teacher,
    "exam@local.test",
    await bcrypt.hash(password, 4),
    other,
    "other@local.test",
  ]);
  const secret=randomBytes(48).toString("hex");
  let { app, attach, online, drain } = createApp(db,secret);
  let server = http.createServer(app), live = attach(server);
  if (pollingOnly) {
    live.engine.opts.transports = ["polling"];
    live.engine.opts.allowUpgrades = false;
  }
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = async (path, body, token, method) => {
    const form = body instanceof FormData;
    const r = await fetch(base + "/api" + path, {
      method: method || (body ? "POST" : "GET"),
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(!form ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
    });
    const data = r.headers.get("content-type")?.includes("application/json")
      ? await r.json()
      : Buffer.from(await r.arrayBuffer());
    return { status: r.status, data, headers: r.headers };
  };
  const token = (
      await request("/login", { email: "exam@local.test", password })
    ).data.token,
    otherToken = (
      await request("/login", { email: "other@local.test", password })
    ).data.token;
  const enroll = async (name = "Exam student", credential = token) => {
    const code = (await request("/enrollment", {}, credential)).data.code;
    return (await request("/enroll", { name, code })).data;
  };
  const launch = async (device) => {
    const r = await request("/student/launch", {}, device.token);
    if (r.status !== 200) return r;
    return request("/student/exchange", { code: r.data.code });
  };
  const restart = async () => {
    if(!persistentDirectory) throw Error('Restart requires isolated persistent database');
    const port=server.address().port;
    await new Promise(r=>live.close(r));
    server.close();
    await drain();
    await db.close();
    db=new PGlite(persistentDirectory);
    await migrate(db);
    await db.query("UPDATE sessions SET status='ended',ended_at=now() WHERE status='active'");
    ({app,attach,online,drain}=createApp(db,secret));
    server=http.createServer(app); live=attach(server);
    await new Promise(r=>server.listen(port,'127.0.0.1',r));
  };
  const close = async () => {
    await new Promise((r) => live.close(r));
    server.close();
    await drain();
    await db.close();
  };
  return {
    get db(){return db;},
    restart,
    base,
    request,
    token,
    otherToken,
    teacher,
    other,
    password,
    enroll,
    launch,
    close,
    online,
    live,
  };
}
export function uploadForm(
  bytes,
  {
    title = "Algebra examination",
    subject = "Mathematics",
    totalMarks = "20",
    durationMinutes = "1",
    filename = "paper.pdf",
    type = "application/pdf",
  } = {},
) {
  const form = new FormData();
  form.set("title", title);
  form.set("subject", subject);
  form.set("totalMarks", totalMarks);
  form.set("durationMinutes", durationMinutes);
  form.set("pdf", new Blob([bytes], { type }), filename);
  return form;
}

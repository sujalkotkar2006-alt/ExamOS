import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName } from "pdf-lib";
import jwt from "jsonwebtoken";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
test("real PDF upload, assignment, enrolled-device authorization, exam lifecycle and audit", async () => {
  const f = await fixture(),
    { db, request: r, token: t, otherToken: o } = f;
  try {
    const bytes = await actualPaper();
    assert.equal((await r("/papers", uploadForm(bytes))).status, 401);
    assert.equal(
      (
        await r(
          "/papers",
          uploadForm(Buffer.from("%PDF-not-a-document\n%%EOF")),
          t,
        )
      ).status,
      400,
    );
    assert.equal(
      (await r("/papers", uploadForm(bytes, { filename: "paper.txt" }), t))
        .status,
      400,
    );
    assert.equal(
      (await r("/papers", uploadForm(bytes, { durationMinutes: "0" }), t))
        .status,
      400,
    );
    const activePdf = await PDFDocument.load(bytes);
    activePdf.catalog.set(
      PDFName.of("OpenAction"),
      activePdf.context.obj({
        S: PDFName.of("JavaScript"),
        JS: "app.alert(1)",
      }),
    );
    assert.equal(
      (await r("/papers", uploadForm(await activePdf.save()), t)).status,
      400,
    );
    const uploaded = await r("/papers", uploadForm(bytes), t);
    assert.equal(uploaded.status, 201);
    const paper = uploaded.data.id;
    const pdf = await r("/papers/" + paper + "/pdf", null, t);
    assert.equal(pdf.status, 200);
    assert.deepEqual(pdf.data, bytes);
    assert.equal(pdf.headers.get("cache-control"), "no-store");
    assert.equal((await r("/papers/" + paper + "/pdf", null, o)).status, 404);
    assert.equal((await r("/papers", null, o)).data.length, 0);
    const student = await f.enroll("Assigned student"),
      excluded = await f.enroll("Excluded student"),
      foreign = await f.enroll("Other teacher", o);
    const session = (await r("/sessions", { name: "Paper lifecycle test" }, t))
      .data.id;
    assert.equal(
      (
        await r(
          "/sessions/" + session + "/paper",
          { paperId: paper, deviceIds: [foreign.id] },
          t,
        )
      ).status,
      403,
    );
    assert.equal(
      (await r("/sessions/" + session + "/paper", { paperId: paper }, o))
        .status,
      404,
    );
    assert.equal(
      (
        await r(
          "/sessions/" + session + "/paper",
          {
            paperId: paper,
            deviceIds: [student.id],
            opensAt: new Date(Date.now() + 60000).toISOString(),
          },
          t,
        )
      ).status,
      200,
    );
    assert.equal((await f.launch(excluded)).status, 404);
    assert.equal((await f.launch(foreign)).status, 404);
    const code = (await r("/student/launch", {}, student.token)).data.code;
    const exchange = await r("/student/exchange", { code });
    assert.equal(exchange.status, 200);
    const browser = exchange.data.token;
    const claims = jwt.decode(browser);
    assert.equal(claims.role, "student");
    assert.equal(claims.sessionId, session);
    assert.equal(claims.exp - claims.iat, 8 * 3600);
    assert.equal((await r("/student/exchange", { code })).status, 401);
    assert.equal((await r("/state", null, browser)).status, 401);
    assert.equal((await r("/student/exam/pdf", null, browser)).status, 409);
    assert.equal((await r("/student/exam/start", {}, browser)).status, 409);
    await db.query(
      "UPDATE session_papers SET opens_at=now()-interval '1 minute',closes_at=now()+interval '5 minutes' WHERE session_id=$1",
      [session],
    );
    await f.monitor(student, session);
    assert.deepEqual((await r("/student/exam/pdf", null, browser)).data, bytes);
    let progress = (await r("/sessions/" + session + "/exam-status", null, t))
      .data;
    assert.equal(progress.students.length, 1);
    assert.equal(progress.students[0].status, "opened");
    assert.equal(
      (await r("/sessions/" + session + "/paper", { paperId: paper }, t))
        .status,
      409,
    );
    assert.equal(
      (
        await r(
          "/student/exam/submit",
          { answers: "Too early", revision: 0, mutationId: randomUUID() },
          browser,
        )
      ).status,
      409,
    );
    const start = (await r("/student/exam/start", {}, browser)).data;
    assert.equal(start.status, "started");
    assert.ok(new Date(start.deadline_at) > new Date());
    assert.equal(
      (await r("/student/exam/start", {}, browser)).data.deadline_at,
      start.deadline_at,
    );
    assert.equal(
      (
        await r(
          "/student/exam/save",
          {
            answers: "1. x = 6\n2. 40 square centimetres",
            revision: 0,
            mutationId: randomUUID(),
          },
          browser,
        )
      ).status,
      200,
    );
    progress = (await r("/sessions/" + session + "/exam-status", null, t)).data;
    assert.equal(progress.students[0].status, "started");
    assert.ok(
      progress.students[0].remainingSeconds > 0 &&
        progress.students[0].remainingSeconds <= 60,
    );
    const submission = (
      await r(
        "/student/exam/submit",
        {
          answers: "1. x = 6\n2. 40 square centimetres",
          revision: 1,
          mutationId: randomUUID(),
        },
        browser,
      )
    ).data;
    assert.equal(submission.status, "submitted");
    assert.equal(submission.submission_reason, "manual");
    assert.equal(
      (
        await r(
          "/student/exam/submit",
          { answers: "Duplicate", revision: 0, mutationId: randomUUID() },
          browser,
        )
      ).data.id,
      submission.id,
    );
    assert.equal((await r("/student/exam/pdf", null, browser)).status, 409);
    assert.equal((await r("/papers/" + paper + "/delete", {}, t)).status, 409);
    progress = (await r("/sessions/" + session + "/exam-status", null, t)).data;
    assert.equal(progress.students[0].status, "submitted");
    assert.match(progress.students[0].answers, /x = 6/);
    const audits = (await r("/paper-audit", null, t)).data;
    for (const action of [
      "paper_uploaded",
      "paper_assigned",
      "paper_opened",
      "exam_started",
      "exam_submitted",
    ])
      assert.ok(
        audits.some((x) => x.action === action),
        action,
      );
    assert.equal(audits.filter((x) => x.action === "exam_submitted").length, 1);
    assert.equal((await r("/paper-audit", null, o)).data.length, 0);
    await r("/sessions/" + session + "/end", {}, t);
    assert.equal((await r("/student/exam/pdf", null, browser)).status, 409);
    assert.equal((await r("/papers/" + paper + "/delete", {}, t)).status, 200);
    assert.equal((await r("/papers", null, t)).data.length, 0);
    const receipt = (await r("/student/exam", null, browser)).data;
    assert.equal(receipt.attempt.status, "submitted");
    await r("/devices/" + student.id + "/revoke", {}, t);
    assert.equal((await r("/student/exam", null, browser)).status, 401);
    console.log(
      "PASS: actual uploaded PDF round-trip; PDF safety; ownership; selected device access; launch replay rejection; open/start/save/submit; teacher progress; private PDF revocation; audit.",
    );
  } finally {
    await f.close();
  }
});
test("server deadlines automatically close sessions and preserve saved responses without browser timers", async () => {
  const f = await fixture(),
    { db, request: r, token: t } = f;
  try {
    const paper = (await r("/papers", uploadForm(await actualPaper()), t)).data
      .id;
    const session = (await r("/sessions", { name: "Server deadline test" }, t))
      .data.id;
    await r("/sessions/" + session + "/paper", { paperId: paper }, t);
    const device = await f.enroll("Late enrolled student");
    const token = (await f.launch(device)).data.token;
    await f.monitor(device, session);
    await r("/student/exam/start", {}, token);
    await r(
      "/student/exam/save",
      {
        answers: "Persisted before deadline",
        revision: 0,
        mutationId: randomUUID(),
      },
      token,
    );
    await db.query(
      "UPDATE session_papers SET closes_at=now()+interval '1 second' WHERE session_id=$1",
      [session],
    );
    await pause(2300);
    const state = (await r("/state", null, t)).data;
    assert.equal(state.sessions[0].status, "ended");
    const progress = (await r("/sessions/" + session + "/exam-status", null, t))
      .data;
    assert.equal(progress.students[0].status, "submitted");
    assert.equal(progress.students[0].submission_reason, "timeout");
    assert.equal(progress.students[0].answers, "Persisted before deadline");
    assert.equal((await r("/student/exam/pdf", null, token)).status, 409);
    assert.equal((await r("/student/exam/start", {}, token)).status, 409);
    console.log(
      "PASS: later enrollment assignment, server timer closure, timed submission and persisted response.",
    );
  } finally {
    await f.close();
  }
});

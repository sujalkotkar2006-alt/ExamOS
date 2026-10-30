import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";
import { AnswerSync } from "../dashboard/src/answerSync.js";

test("a paused save retains its request and resumes without a conflict", async () => {
  let paused = true;
  const calls = [];
  const sync = new AnswerSync({
    revision: 0,
    answers: "",
    status: () => {},
    acknowledged: () => {},
    send: async (path, body) => {
      calls.push(body);
      if (paused) throw Object.assign(Error("Paused"), { status: 423 });
      return { revision: 1 };
    },
  });
  sync.edit("retained during pause", 0);
  await sync.flush(false, 1000);
  assert.equal(sync.stopped, false);
  assert.equal(sync.latest, "retained during pause");
  paused = false;
  await sync.flush(false, 2000);
  assert.equal(sync.accepted, "retained during pause");
  assert.equal(calls[0].mutationId, calls[1].mutationId);
});

test("manual exam controls are scoped, audited, replay-safe and enforced by the student API", async () => {
  const f = await fixture();
  try {
    const paper = (
      await f.request(
        "/papers",
        uploadForm(await actualPaper(), { durationMinutes: "5" }),
        f.token,
      )
    ).data.id;
    const session = (
      await f.request("/sessions", { name: "Manual review classroom" }, f.token)
    ).data.id;
    await f.request(`/sessions/${session}/paper`, { paperId: paper }, f.token);
    const first = await f.enroll("First student"),
      second = await f.enroll("Second student");
    const start = (await f.request("/student/exam/start", {}, first.token))
      .data;
    const other = (await f.request("/student/exam/start", {}, second.token))
      .data;
    const path = `/sessions/${session}/attempts/${start.id}/control`;
    const command = {
      action: "pause",
      reason: "Review recorded application event",
      commandId: randomUUID(),
    };
    const save = {
      answers: "acknowledged answer",
      revision: 0,
      mutationId: randomUUID(),
    };
    assert.equal(
      (await f.request("/student/exam/save", save, first.token)).status,
      200,
    );
    assert.equal((await f.request(path, command, f.otherToken)).status, 404);
    assert.equal((await f.request(path, command, first.token)).status, 401);
    assert.equal(
      (await f.request(path, { ...command, reason: "" }, f.token)).status,
      400,
    );
    assert.equal((await f.request(path, command, f.token)).status, 200);
    assert.equal(
      (await f.request(path, command, f.token)).data.duplicate,
      true,
    );
    assert.equal(
      (await f.request(path, { ...command, action: "end" }, f.token)).status,
      409,
    );
    assert.equal(
      (await f.request("/student/exam/pdf", null, first.token)).status,
      423,
    );
    assert.equal(
      (await f.request("/student/exam/save", save, first.token)).status,
      423,
    );
    assert.equal(
      (
        await f.request(
          "/student/exam/submit",
          { ...save, revision: 1 },
          first.token,
        )
      ).status,
      423,
    );
    const paused = (await f.request("/student/exam", null, first.token)).data
      .attempt;
    assert.equal(paused.deadline_at, start.deadline_at);
    assert.ok(paused.paused_at);
    assert.equal(
      (await f.request("/student/exam", null, second.token)).data.attempt
        .paused_at,
      null,
    );
    assert.equal(
      (
        await f.request(
          path,
          {
            action: "resume",
            reason: "Review completed",
            commandId: randomUUID(),
          },
          f.token,
        )
      ).status,
      200,
    );
    const resumed = (await f.request("/student/exam", null, first.token)).data
      .attempt;
    assert.equal(resumed.deadline_at, start.deadline_at);
    assert.equal(resumed.paused_at, null);
    // Failure to append the audit rolls back the control and its receipt.
    await f.db.query(
      "ALTER TABLE paper_audit ADD CONSTRAINT reject_control_test CHECK(action<>'exam_control') NOT VALID",
    );
    const rejected = { ...command, commandId: randomUUID() };
    assert.equal((await f.request(path, rejected, f.token)).status, 500);
    assert.equal(
      (await f.request("/student/exam", null, first.token)).data.attempt
        .paused_at,
      null,
    );
    assert.equal(
      (
        await f.db.query("SELECT 1 FROM exam_controls WHERE id=$1", [
          rejected.commandId,
        ])
      ).rows.length,
      0,
    );
    await f.db.query(
      "ALTER TABLE paper_audit DROP CONSTRAINT reject_control_test",
    );
    const end = {
      action: "end",
      reason: "Invigilator ended attempt after review",
      commandId: randomUUID(),
    };
    const replies = await Promise.all([
      f.request(path, end, f.token),
      f.request(path, end, f.token),
    ]);
    assert.equal(replies[0].data.receipt.id, replies[1].data.receipt.id);
    const ended = (await f.request("/student/exam", null, first.token)).data
      .attempt;
    assert.equal(ended.status, "submitted");
    assert.equal(ended.submission_reason, "teacher_ended");
    assert.equal(ended.answers, "acknowledged answer");
    assert.equal(
      (
        await f.request(
          path,
          {
            action: "resume",
            reason: "Cannot reopen",
            commandId: randomUUID(),
          },
          f.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          "/student/exam/save",
          { ...save, revision: 1, mutationId: randomUUID() },
          first.token,
        )
      ).status,
      409,
    );
    const progress = (
      await f.request(`/sessions/${session}/exam-status`, null, f.token)
    ).data;
    assert.equal(progress.controls.length, 3);
    assert.equal(progress.students.length, 2);
    assert.equal(
      progress.students.find((s) => s.device_id === second.id).status,
      "started",
    );
    assert.ok(
      progress.controls.every((c) => c.teacher_id === f.teacher && c.reason),
    );
    assert.equal(
      (await f.request(`/sessions/${session}/exam-status`, null, f.otherToken))
        .status,
      404,
    );
    const incident = randomUUID();
    await f.db.query(
      "INSERT INTO proctor_events(id,teacher_id,session_id,device_id,attempt_id,category,observed_at) VALUES ($1,$2,$3,$4,$5,'window_blur',now())",
      [incident, f.teacher, session, second.id, other.id],
    );
    assert.equal(
      (
        await f.request(
          `/proctor/incidents?studentId=${second.id}&sessionId=${session}`,
          null,
          f.token,
        )
      ).data.total,
      1,
    );
    assert.equal(
      (
        await f.request(
          `/proctor/incidents?studentId=${first.id}&sessionId=${session}`,
          null,
          f.token,
        )
      ).data.total,
      0,
    );
    assert.equal(
      (
        await f.request(
          `/proctor/incidents?studentId=${second.id}`,
          null,
          f.otherToken,
        )
      ).data.total,
      0,
    );
    await f.request(
      `/proctor/events/${incident}/review`,
      { status: "dismissed", note: "Reviewed and ignored" },
      f.token,
    );
    assert.equal(
      (await f.request(`/proctor/events/${incident}`, null, f.token)).data
        .reviews.length,
      1,
    );
    // Expiry still submits a paused attempt; resume cannot extend its deadline.
    const secondPath = `/sessions/${session}/attempts/${other.id}/control`;
    await f.request(
      secondPath,
      { ...command, commandId: randomUUID() },
      f.token,
    );
    await f.db.query(
      "UPDATE exam_attempts SET deadline_at=now()-interval '1 second' WHERE id=$1",
      [other.id],
    );
    assert.equal(
      (
        await f.request(
          secondPath,
          { action: "resume", reason: "Too late", commandId: randomUUID() },
          f.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (await f.request("/student/exam", null, second.token)).data.attempt
        .submission_reason,
      "timeout",
    );
  } finally {
    await f.close();
  }
});

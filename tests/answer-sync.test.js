import { test } from "node:test";
import assert from "node:assert/strict";
import { AnswerSync } from "../dashboard/src/answerSync.js";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";
import { randomUUID } from "node:crypto";

test("bounded autosave, retry identity, in-flight editing and conflict stop", async () => {
  const requests = [];
  let fail = true,
    release;
  const sync = new AnswerSync({
    revision: 0,
    answers: "",
    status: () => {},
    acknowledged: () => {},
    send: async (path, body) => {
      requests.push({ path, body });
      if (fail) {
        fail = false;
        throw Error("offline");
      }
      return { revision: 1 };
    },
  });
  sync.edit("first", 0);
  for (let t = 500; t < 5000; t += 500) {
    sync.edit(String(t), t);
    await sync.flush(false, t);
  }
  assert.equal(requests.length, 0);
  await sync.flush(false, 5000);
  assert.equal(requests.length, 1);
  await sync.flush(false, 5500);
  assert.equal(requests.length, 1);
  await sync.flush(false, 6000);
  assert.equal(requests[0].body.mutationId, requests[1].body.mutationId);
  sync.edit("new", 7000);
  sync.send = () =>
    new Promise((r) => {
      release = r;
    });
  const pending = sync.flush(false, 8000);
  sync.edit("newer", 8100);
  await sync.flush(false, 8200);
  release({ revision: 2 });
  await pending;
  assert.equal(sync.latest, "newer");
  assert.equal(sync.accepted, "new");
  sync.send = async () => {
    throw Object.assign(Error("conflict"), { status: 409 });
  };
  await sync.flush(false, 10000);
  assert.equal(sync.stopped, true);
});

test("SQL response revisions reject stale writes; lost acknowledgements and duplicate submits are safe", async () => {
  const f = await fixture();
  try {
    const paper = (
      await f.request("/papers", uploadForm(await actualPaper()), f.token)
    ).data.id;
    const session = (
      await f.request("/sessions", { name: "response failures" }, f.token)
    ).data.id;
    await f.request(`/sessions/${session}/paper`, { paperId: paper }, f.token);
    const device = await f.enroll();
    await f.monitor(device, session);
    await f.request("/student/exam/start", {}, device.token);
    const save = { answers: "one", revision: 0, mutationId: randomUUID() };
    assert.equal(
      (
        await f.request(
          "/student/exam/save",
          { answers: "invalid", mutationId: randomUUID() },
          device.token,
        )
      ).status,
      400,
    );
    assert.equal(
      (await f.request("/student/exam/save", save, device.token)).data.revision,
      1,
    );
    assert.equal(
      (
        await f.request(
          "/student/exam/save",
          { ...save, revision: 1, answers: "reused identity" },
          device.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (await f.request("/student/exam/save", save, device.token)).data.revision,
      1,
    );
    assert.equal(
      (
        await f.request(
          "/student/exam/save",
          { ...save, answers: "stale", mutationId: randomUUID() },
          device.token,
        )
      ).status,
      409,
    );
    const submit = { answers: "final", revision: 1, mutationId: randomUUID() };
    const results = await Promise.all([
      f.request("/student/exam/submit", submit, device.token),
      f.request("/student/exam/submit", submit, device.token),
    ]);
    assert.equal(results[0].data.id, results[1].data.id);
    assert.equal(results[0].data.answers, "final");
    assert.equal(
      (await f.request("/student/exam/save", save, device.token)).status,
      409,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::integer AS n FROM paper_audit WHERE session_id=$1 AND action='exam_submitted'",
          [session],
        )
      ).rows[0].n,
      1,
    );
    const second = await f.enroll();
    await f.monitor(second, session);
    await f.request("/student/exam/start", {}, second.token);
    await f.db.query(
      "UPDATE exam_attempts SET deadline_at=now()-interval '1 second' WHERE device_id=$1",
      [second.id],
    );
    assert.equal(
      (await f.request("/student/exam/save", save, second.token)).status,
      409,
    );
    const late = await f.request("/student/exam/submit", submit, second.token);
    assert.equal(late.data.answers, "");
    assert.equal(late.data.submission_reason, "timeout");
  } finally {
    await f.close();
  }
});

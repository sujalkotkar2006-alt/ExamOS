import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";

test("exam start and pre-start PDF require fresh session-scoped screen monitoring", async () => {
  const f = await fixture();
  try {
    const paper = (await f.request("/papers", uploadForm(await actualPaper()), f.token)).data.id;
    const session = (await f.request("/sessions", { name: "Monitoring admission" }, f.token)).data.id;
    await f.request(`/sessions/${session}/paper`, { paperId: paper }, f.token);
    const device = await f.enroll();
    const browser = (await f.launch(device)).data.token;
    const ready = async () => (await f.request("/student/exam", null, browser)).data.monitoring.ready;
    const start = () => f.request("/student/exam/start", { monitoring: true, focusConsent: true }, browser);
    const blocked = async () => {
      assert.equal(await ready(), false);
      const response = await start();
      assert.equal(response.status, 409);
      assert.match(response.data.error, /screen sharing/);
      assert.equal((await f.request("/student/exam/pdf", null, browser)).status, 409);
      assert.equal((await f.db.query("SELECT count(*)::int AS n FROM exam_attempts WHERE device_id=$1", [device.id])).rows[0].n, 0);
    };
    await blocked(); // Enrollment and a browser-supplied boolean cannot grant consent.
    const monitor = await f.monitor(device, session);
    monitor.pause();
    assert.equal(await ready(), true);
    const state = f.online.get(device.id);
    const lastSeen = state.lastSeen;
    state.lastSeen = Date.now() - 9000;
    await blocked(); // Expired heartbeat lease.
    state.lastSeen = lastSeen;
    state.lastSample = Date.now() - 9000;
    await blocked(); // Live connection without fresh screen previews.
    state.lastSample = 0;
    await monitor.sample();
    state.screenSampleSession = randomUUID();
    await blocked(); // Another session's preview cannot satisfy admission.
    state.screenSampleSession = session;
    await monitor.call("consent", { sessionId: session, accept: false });
    await blocked();
    await monitor.call("consent", { sessionId: session, accept: true });
    await blocked(); // Fresh consent alone cannot reuse a previous preview.
    await monitor.sample();
    assert.equal(await ready(), true);
    monitor.stop();
    await new Promise(resolve => setTimeout(resolve, 50));
    await blocked(); // Disconnect/reconnect must require fresh consent and sample.
    const replacement = await f.monitor(device, session);
    assert.equal(await ready(), true);
    const started = await start();
    assert.equal(started.status, 200);
    assert.equal(started.data.status, "started");
    replacement.stop();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await ready(), false);
    const retry = await start();
    assert.equal(retry.data.id, started.data.id);
    assert.equal(retry.data.deadline_at, started.data.deadline_at);
    assert.equal((await f.request("/student/exam/save", { answers: "Preserved after disconnect", revision: 0, mutationId: randomUUID() }, browser)).status, 200);
  } finally { await f.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { io as connect } from "socket.io-client";
import {testDatabase} from "./test-database.mjs";
import { createApp } from "../server/app.js";
import { migrate, database } from "../server/db.js";
const secret = "integration-test-secret-at-least-32-characters";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, name, p) =>
  new Promise((resolve, reject) =>
    s.timeout(3000).emit(name, p, (e, r) => (e ? reject(e) : resolve(r))),
  );
const socket = (url, auth) =>
  new Promise((resolve, reject) => {
    const s = connect(url, { auth, reconnection: false });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
test("complete authenticated session lifecycle and isolation", async () => {
  const db = await testDatabase();
  await migrate(db);
  await migrate(db);
  const { app, attach, drain } = createApp(db, secret);
  const server = http.createServer(app);
  const live = attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const clients = [];
  const id = randomUUID(),
    other = randomUUID();
  await db.query("INSERT INTO teachers VALUES ($1,$2,$3),($4,$5,$6)", [
    id,
    "first-" + id + "@test.local",
    await bcrypt.hash("correct-password", 4),
    other,
    "second-" + other + "@test.local",
    await bcrypt.hash("other-password", 4),
  ]);
  const req = async (path, body, token) => {
    const r = await fetch(base + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    assert.equal((await req("/state")).status, 401);
    assert.equal(
      (
        await req("/login", {
          email: "first-" + id + "@test.local",
          password: "wrong",
        })
      ).status,
      401,
    );
    const token = (
      await req("/login", {
        email: "first-" + id + "@test.local",
        password: "correct-password",
      })
    ).data.token;
    const second = (
      await req("/login", {
        email: "second-" + other + "@test.local",
        password: "other-password",
      })
    ).data.token;
    const code = (await req("/enrollment", {}, token)).data.code;
    const device = (
      await req("/enroll", { code, name: "Test protocol client" })
    ).data;
    assert.equal(
      (await req("/devices/" + device.id + "/revoke", {}, second)).status,
      404,
    );
    await db.query(
      "INSERT INTO enrollments VALUES ($1,$2,now()-interval '1 minute')",
      [(await import("../server/app.js")).hash("expired-code"), id],
    );
    assert.equal(
      (await req("/enroll", { code: "expired-code", name: "Expired test" }))
        .status,
      400,
    );
    assert.equal(
      (await req("/enroll", { code, name: "Code replay" })).status,
      400,
    );
    const teacher = await socket(base, { role: "teacher", token });
    clients.push(teacher);
    const student = await socket(base, { token: device.token });
    clients.push(student);
    let previews = [];
    const monitoringStops = [];
    teacher.on("monitoring-stopped", (p) => monitoringStops.push(p));
    teacher.on("preview", (p) => previews.push(p));
    const session = (
      await req(
        "/sessions",
        { name: "Integration examination", allowedApps: ["exam.exe"] },
        token,
      )
    ).data.id;
    assert.equal(
      (await req("/sessions", { name: "Duplicate" }, token)).status,
      409,
    );
    const sample = { sessionId: session, app: "browser.exe", jpeg: "/9j/AAAA" };
    assert.ok((await call(student, "sample", sample)).error);
    assert.equal(previews.length, 0);
    assert.ok(
      (await call(student, "consent", { sessionId: session, accept: true })).ok,
    );
    assert.ok((await call(student, "heartbeat", {})).session);
    assert.ok(
      (await call(student, "sample", { ...sample, app: "[unavailable]" })).ok,
    );
    const technical = (
      await req("/sessions/" + session + "/events", null, token)
    ).data;
    assert.ok(technical.some((e) => e.kind === "telemetry_unavailable"));
    assert.ok(!technical.some((e) => e.kind === "rule_alert"));
    await pause(1600);
    assert.ok((await call(student, "sample", sample)).ok);
    await pause(30);
    assert.equal(previews.length, 2);
    const history = (await req("/sessions/" + session + "/events", null, token))
      .data;
    assert.ok(history.some((e) => e.kind === "consent_granted"));
    const alert = history.find((e) => e.kind === "rule_alert");
    assert.ok(alert);
    assert.ok(history.some((e) => e.kind === "application"));
    assert.deepEqual(
      (await req("/sessions/" + session + "/events", null, second)).data,
      [],
    );
    assert.deepEqual((await req("/state", null, second)).data.devices, []);
    assert.equal(
      (
        await req(
          "/events/" + alert.id + "/review",
          { review: "Unauthorized" },
          second,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await req(
          "/events/" + alert.id + "/review",
          { review: "Reviewed with student; no finding" },
          token,
        )
      ).status,
      200,
    );
    assert.ok(
      (
        await call(student, "consent", {
          sessionId: session,
          accept: false,
          reason: "keyboard_stop",
        })
      ).ok,
    );
    await pause(30);
    assert.equal(monitoringStops.length, 1);
    assert.equal(monitoringStops[0].deviceId, device.id);
    assert.equal(
      monitoringStops[0].reason,
      "Student stopped monitoring using Escape",
    );
    const stoppedState = (await req("/state", null, token)).data.devices.find(
      (d) => d.id === device.id,
    );
    assert.equal(stoppedState.consented, false);
    assert.equal(stoppedState.app, null);
    const stoppedHistory = (
      await req("/sessions/" + session + "/events", null, token)
    ).data;
    assert.ok(
      stoppedHistory.some(
        (e) =>
          e.kind === "consent_withdrawn" &&
          e.detail.reason === "Student stopped monitoring using Escape",
      ),
    );
    assert.ok((await call(student, "sample", sample)).error);
    await call(student, "consent", { sessionId: session, accept: true });
    student.disconnect();
    await pause(100);
    const after = (await req("/sessions/" + session + "/events", null, token))
      .data;
    assert.ok(after.some((e) => e.kind === "connection_lost"));
    assert.ok(!after.some((e) => /cheat/i.test(e.kind)));
    const reconnected = await socket(base, { token: device.token });
    clients.push(reconnected);
    assert.ok((await call(reconnected, "sample", sample)).error);
    await call(reconnected, "consent", { sessionId: session, accept: true });
    assert.equal(
      (await req("/sessions/" + session + "/end", {}, second)).status,
      404,
    );
    assert.equal(
      (await req("/sessions/" + session + "/end", {}, token)).status,
      200,
    );
    assert.equal((await call(reconnected, "heartbeat", {})).session, null);
    assert.ok((await call(reconnected, "sample", sample)).error);
    assert.equal(previews.length, 2);
    assert.equal(
      (await req("/devices/" + device.id + "/revoke", {}, token)).status,
      200,
    );
    await pause(50);
    await assert.rejects(socket(base, { token: device.token }));
    console.log(
      "Verified auth, enrollment replay prevention, isolation, consent, preview forwarding, alerts, review, disconnect, reconnect, end, and revocation.",
    );
  } finally {
    clients.forEach((s) => s.disconnect());
    await new Promise((r) => live.close(r));
    server.close();
    await drain();
    if (db.close) await db.close();
    else await db.end();
  }
});

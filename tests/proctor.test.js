import { test } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import jpeg from "jpeg-js";
import { randomUUID } from "node:crypto";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";
test("consented proctor observations, private evidence, review, retention and all shutdown boundaries", async () => {
  const f = await fixture(),
    r = f.request,
    t = f.token;
  let device, teacher;
  try {
    const p = (await r("/papers", uploadForm(await actualPaper()), t)).data.id;
    const sid = (
      await r("/sessions", { name: "Proctor authorization acceptance" }, t)
    ).data.id;
    assert.equal(
      (await r("/sessions/" + sid + "/paper", { paperId: p }, t)).status,
      200,
    );
    const d = await f.enroll("Consent boundary student");
    const student = (await f.launch(d)).data.token;
    await r("/student/exam", null, student);
    device = io(f.base, {
      auth: { token: d.token },
      transports: ["websocket"],
    });
    teacher = io(f.base, {
      auth: { role: "teacher", token: t },
      transports: ["websocket"],
    });
    await Promise.all(
      [device, teacher].map(
        (s) =>
          new Promise((resolve, reject) => {
            s.on("connect", resolve);
            s.on("connect_error", reject);
          }),
      ),
    );
    const call = (name, payload) =>
      device.timeout(3000).emitWithAck(name, payload);
    const cam = (accept, snapshots = false) =>
      call("camera-consent", { sessionId: sid, accept, snapshots });
    assert.match((await cam(true)).error, /Start/);
    await call("heartbeat", {});
    await call("consent", { sessionId: sid, accept: true });
    await call("sample", { sessionId: sid, app: "exam.exe", jpeg: jpeg.encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) }, 50).data.toString("base64") });
    assert.equal(
      (await r("/student/exam/start", { focusConsent: true }, student)).status,
      200,
    );
    await call("heartbeat", {});
    assert.match(
      (
        await call("proctor-event", {
          sessionId: sid,
          category: "phone_detected",
        })
      ).error,
      /consent/,
    );
    assert.ok((await cam(true)).ok);
    const bytes = jpeg.encode(
      {
        width: 2,
        height: 2,
        data: Buffer.from([
          20, 30, 40, 255, 50, 60, 70, 255, 80, 90, 100, 255, 110, 120, 130,
          255,
        ]),
      },
      60,
    ).data;
    const observation = {
      clientEventId: randomUUID(),
      deviceId: d.id,
      studentId: d.id,
      sessionId: sid,
      category: "phone_detected",
      detail: { phoneCount: 1, privateMessage: "must not be stored" },
      jpeg: bytes.toString("base64"),
    };
    assert.match(
      (await call("proctor-event", observation)).error,
      /Separately consented/,
    );
    assert.ok((await cam(true, true)).ok);
    assert.ok(
      (await call("camera-status", { sessionId: sid, status: "active" })).ok,
    );
    const notified = new Promise((resolve) =>
      teacher.once("proctor-refresh", resolve),
    );
    const saved = await call("proctor-event", observation);
    assert.ok(saved.ok);
    await notified;
    const id = saved.id;
    const replay = await call("proctor-event", observation);
    assert.equal(replay.id, id);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.evidenceId, saved.evidenceId);
    assert.equal(
      (
        await call("proctor-event", {
          ...observation,
          category: "multiple_people",
        })
      ).status,
      409,
    );
    assert.equal(
      (await call("proctor-event", { ...observation, deviceId: randomUUID() }))
        .status,
      403,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM proctor_events WHERE detail->>'clientEventId'=$1",
          [observation.clientEventId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal((await r("/proctor/events/" + id + "/evidence")).status, 401);
    assert.equal(
      (await r("/proctor/events/" + id + "/evidence", null, f.otherToken))
        .status,
      404,
    );
    assert.equal(
      (await r("/proctor/events/" + id + "/evidence", null, student)).status,
      401,
    );
    assert.deepEqual(
      (await r("/proctor/events/" + id + "/evidence", null, t)).data,
      bytes,
    );
    const stored = (
      await f.db.query("SELECT * FROM proctor_events WHERE id=$1", [id])
    ).rows[0];
    assert.equal(stored.detail.privateMessage, undefined);
    const catalog = (await r("/proctor/evidence", null, t)).data;
    assert.equal(catalog.total, 1);
    const asset = catalog.items[0];
    assert.equal(asset.event_id, id);
    assert.equal(asset.student_id, d.id);
    assert.equal(asset.mime_type, "image/jpeg");
    assert.equal(asset.kind, "snapshot");
    assert.ok(asset.examination_id);
    assert.ok(asset.storage_location.startsWith("postgresql:proctor_events/"));
    assert.equal(
      (
        await r(
          "/proctor/evidence?studentId=" +
            d.id +
            "&sessionId=" +
            sid +
            "&kind=snapshot&category=phone_detected&search=" +
            d.id.slice(0, 8),
          null,
          t,
        )
      ).data.total,
      1,
    );
    const before = new Date(
        new Date(asset.captured_at).getTime() - 1000,
      ).toISOString(),
      after = new Date(
        new Date(asset.captured_at).getTime() + 1000,
      ).toISOString();
    assert.equal(
      (
        await r(
          "/proctor/evidence?from=" +
            encodeURIComponent(before) +
            "&to=" +
            encodeURIComponent(after),
          null,
          t,
        )
      ).data.total,
      1,
    );
    assert.equal(
      (await r("/proctor/evidence?from=invalid-date", null, t)).status,
      400,
    );
    assert.equal(
      (await r("/proctor/live", null, t)).data.devices.find(
        (x) => x.id === d.id,
      ).latestSnapshot.session_id,
      sid,
    );
    assert.equal((await r("/proctor/evidence")).status, 401);
    assert.equal((await r("/proctor/evidence", null, student)).status, 401);
    assert.equal(
      (await r("/proctor/evidence", null, f.otherToken)).data.total,
      0,
    );
    assert.equal(
      (
        await r(
          "/proctor/evidence/" + asset.id + "/content",
          null,
          f.otherToken,
        )
      ).status,
      404,
    );
    assert.deepEqual(
      (await r("/proctor/evidence/" + asset.id + "/content", null, t)).data,
      bytes,
    );
    assert.equal(
      (await r("/proctor/summary", null, t)).data.snapshots_available,
      1,
    );
    await f.db.query("UPDATE proctor_events SET evidence=NULL WHERE id=$1", [
      id,
    ]);
    assert.equal(
      (await r("/proctor/evidence/" + asset.id + "/content", null, t)).status,
      410,
    );
    assert.equal(
      (await r("/proctor/evidence", null, t)).data.items[0].availability,
      "missing",
    );
    await f.db.query("UPDATE proctor_events SET evidence=$2 WHERE id=$1", [
      id,
      bytes,
    ]);
    const noHandler = await r(
      "/proctor/devices/" + d.id + "/camera-check",
      {},
      t,
    );
    assert.equal(
      noHandler.status,
      502,
      "An outdated agent must return a clear failure rather than a false capture success",
    );
    assert.match(stored.detail.interpretation, /No automatic/);
    assert.equal(
      (await r("/proctor/events/" + id, null, f.otherToken)).status,
      404,
    );
    const blockedClip = await fetch(
      f.base + "/api/student/incidents/" + id + "/clip",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + d.token,
          "Content-Type": "video/webm",
        },
        body: Buffer.from("invalid upload; no video fixture"),
      },
    );
    assert.equal(
      blockedClip.status,
      403,
      "Separate clip consent must precede even decoding an upload",
    );
    assert.equal(
      (
        await r(
          "/proctor/settings",
          { retentionDays: 7, cooldownSeconds: 9, clipSeconds: 10 },
          t,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await r(
          "/proctor/settings",
          { retentionDays: 7, cooldownSeconds: 30, clipSeconds: 21 },
          t,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await r(
          "/proctor/settings",
          { retentionDays: 7, cooldownSeconds: 60, clipSeconds: 12 },
          t,
        )
      ).status,
      200,
    );
    const captureSettings = (await r("/proctor/live", null, t)).data.settings;
    assert.equal(captureSettings.cooldownSeconds, 60);
    assert.equal(captureSettings.clipSeconds, 12);
    const limitedGrant = await call("camera-consent", {
      sessionId: sid,
      accept: true,
      snapshots: true,
      clips: true,
      retentionDays: 1,
      clipSeconds: 4,
      cooldownSeconds: 90,
    });
    assert.ok(limitedGrant.ok);
    assert.equal(limitedGrant.retentionDays, 1);
    assert.equal(limitedGrant.clipSeconds, 4);
    assert.equal(limitedGrant.cooldownSeconds, 90);
    assert.equal(
      (
        await r(
          "/proctor/events/" + id + "/review",
          {
            status: "dismissed",
            note: "Detector test fixture, no misconduct conclusion",
          },
          t,
        )
      ).status,
      200,
    );
    assert.equal(
      (await r("/proctor/live", null, t)).data.events[0].review_status,
      "dismissed",
    );
    for (const status of ["false_positive", "requires_investigation"])
      assert.equal(
        (
          await r(
            "/proctor/events/" + id + "/review",
            { status, note: "Protocol audit verification" },
            t,
          )
        ).status,
        200,
      );
    const detail = (await r("/proctor/events/" + id, null, t)).data;
    assert.deepEqual(
      detail.reviews.map((x) => x.status),
      ["dismissed", "false_positive", "requires_investigation"],
    );
    assert.equal(detail.category, stored.category);
    assert.deepEqual(detail.detail, stored.detail);
    assert.equal(
      new Date(detail.observed_at).getTime(),
      new Date(stored.observed_at).getTime(),
    );
    await f.db.query(
      "ALTER TABLE proctor_reviews ADD CONSTRAINT audit_failure_test CHECK(comment<>'reject audit write') NOT VALID",
    );
    assert.equal(
      (
        await r(
          "/proctor/events/" + id + "/review",
          { status: "reviewed", note: "reject audit write" },
          t,
        )
      ).status,
      500,
    );
    const unchanged = (await r("/proctor/events/" + id, null, t)).data;
    assert.equal(unchanged.review_status, "requires_investigation");
    assert.equal(unchanged.reviews.length, 3);
    await f.db.query(
      "ALTER TABLE proctor_reviews DROP CONSTRAINT audit_failure_test",
    );
    assert.equal(
      (await r("/proctor/settings", { retentionDays: 1 }, t)).status,
      200,
    );
    await f.db.query(
      "UPDATE proctor_events SET evidence_expires_at=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    assert.equal(
      (await r("/proctor/events/" + id + "/evidence", null, t)).status,
      404,
    );
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(
      (
        await f.db.query("SELECT evidence FROM proctor_events WHERE id=$1", [
          id,
        ])
      ).rows[0].evidence,
      null,
    );
    assert.equal(
      (await r("/student/proctor-event", { category: "window_blur" }, student))
        .status,
      200,
    );
    await cam(false);
    assert.match(
      (
        await call("proctor-event", {
          sessionId: sid,
          category: "no_person_detected",
        })
      ).error,
      /consent/,
    );
    await cam(true, true);
    assert.equal(
      (await r("/student/stop-monitoring", {}, student)).status,
      200,
    );
    assert.equal(f.online.get(d.id).cameraConsent, null);
    assert.equal(
      (await r("/student/proctor-event", { category: "window_blur" }, student))
        .status,
      403,
    );
    await cam(true, true);
    const extra = await call("proctor-event", {
      ...observation,
      clientEventId: randomUUID(),
      category: "multiple_people",
    });
    assert.ok(extra.ok);
    const extraAsset = (
      await r("/proctor/evidence?eventId=" + extra.id, null, t)
    ).data.items[0];
    assert.equal(
      (
        await r(
          "/proctor/evidence/" + extraAsset.id,
          null,
          f.otherToken,
          "DELETE",
        )
      ).status,
      404,
    );
    assert.equal(
      (await r("/proctor/evidence/" + extraAsset.id, null, t, "DELETE")).status,
      200,
    );
    assert.equal(
      (await r("/proctor/evidence/" + extraAsset.id + "/content", null, t))
        .status,
      410,
    );
    assert.equal(
      (await r("/proctor/events/" + extra.id + "/delete-evidence", {}, t))
        .status,
      200,
    );
    assert.equal(
      (await r("/proctor/events/" + extra.id + "/evidence", null, t)).status,
      404,
    );
    const finished = new Promise((resolve) =>
      device.once("exam-finished", resolve),
    );
    assert.equal(
      (
        await r(
          "/student/exam/submit",
          {
            answers: "Actual persisted test response",
            revision: 0,
            mutationId: randomUUID(),
          },
          student,
        )
      ).status,
      200,
    );
    await finished;
    assert.equal(f.online.get(d.id).cameraConsent, null);
    assert.match((await cam(true)).error, /Start/);
    assert.match(
      (await call("consent", { sessionId: sid, accept: true })).error,
      /completed/,
    );
    assert.equal(
      (await r("/student/proctor-event", { category: "window_blur" }, student))
        .status,
      403,
    );
    await r("/sessions/" + sid + "/end", {}, t);
    assert.match((await cam(true)).error, /active/);
    const audit = (await r("/sessions/" + sid + "/events", null, t)).data;
    for (const kind of [
      "camera_consent_granted",
      "camera_consent_withdrawn",
      "proctor_observation",
      "proctor_review",
      "proctor_evidence_deleted",
      "consent_withdrawn",
    ])
      assert.ok(
        audit.some((e) => e.kind === kind),
        kind,
      );
    console.log(
      "PASS: real database/API/Socket.IO authorization and sensor boundaries; JPEG here is an explicitly labelled codec fixture, not a webcam test.",
    );
  } finally {
    device?.disconnect();
    teacher?.disconnect();
    await f.close();
  }
});

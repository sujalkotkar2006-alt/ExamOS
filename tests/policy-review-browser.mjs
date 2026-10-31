import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { randomUUID } from "node:crypto";
import jpeg from "jpeg-js";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";
const f = await fixture();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.EXAMOS_TEST_BROWSER
    ? { channel: process.env.EXAMOS_TEST_BROWSER }
    : {}),
});
let socket, heartbeat;
try {
  const paper = (
    await f.request(
      "/papers",
      uploadForm(await actualPaper(), { durationMinutes: "5" }),
      f.token,
    )
  ).data.id;
  const session = (
    await f.request(
      "/sessions",
      { name: "Policy review end to end", allowedApps: ["exam.exe"] },
      f.token,
    )
  ).data.id;
  await f.request(`/sessions/${session}/paper`, { paperId: paper }, f.token);
  const device = await f.enroll("Policy student");
  await f.monitor(device, session);
  const attempt = (
    await f.request("/student/exam/start", { focusConsent: true }, device.token)
  ).data;
  const withoutWindowConsent = await f.enroll("No window-event consent");
  await f.monitor(withoutWindowConsent, session);
  await f.request("/student/exam/start", {}, withoutWindowConsent.token);
  assert.equal(
    (
      await f.request(
        "/student/proctor-event",
        { category: "window_blur" },
        withoutWindowConsent.token,
      )
    ).status,
    403,
  );
  socket = io(f.base, {
    auth: { token: device.token },
    transports: ["websocket"],
    reconnection: false,
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  const call = (name, payload) =>
    socket.timeout(4000).emitWithAck(name, payload);
  await call("heartbeat", {});
  heartbeat = setInterval(() => call("heartbeat", {}).catch(() => {}), 2000);
  // Transport/codec fixture only: never represented as real webcam/model output.
  const bytes = jpeg.encode(
    { width: 2, height: 2, data: Buffer.alloc(16, 255) },
    50,
  ).data;
  const observation = {
    sessionId: session,
    category: "phone_detected",
    clientEventId: randomUUID(),
    jpeg: bytes.toString("base64"),
    detail: { phoneCount: 1 },
  };
  assert.equal((await call("proctor-event", observation)).status, 403);
  await call("camera-consent", {
    sessionId: session,
    accept: true,
    snapshots: false,
  });
  assert.equal((await call("proctor-event", observation)).status, 403);
  await call("camera-consent", {
    sessionId: session,
    accept: true,
    snapshots: true,
  });
  await call("camera-status", { sessionId: session, status: "active" });
  const phone = await call("proctor-event", observation);
  assert.ok(phone.ok && phone.hasEvidence);
  assert.equal(
    (
      await f.request(
        `/proctor/evidence/${phone.evidenceId}/content`,
        null,
        f.otherToken,
      )
    ).status,
    404,
  );
  const noScreenConsent = await call("sample", {
    sessionId: session,
    app: "blocked.exe",
    jpeg: bytes.toString("base64"),
  });
  assert.match(noScreenConsent.error, /not authorized/);
  await call("consent", { sessionId: session, accept: true });
  await call("sample", {
    sessionId: session,
    app: "exam.exe",
    jpeg: bytes.toString("base64"),
  });
  assert.equal(
    (
      await f.request(
        `/proctor/incidents?studentId=${device.id}`,
        null,
        f.token,
      )
    ).data.events.filter((e) => e.category === "prohibited_application").length,
    0,
  );
  await new Promise((resolve) => setTimeout(resolve, 1600));
  await call("sample", {
    sessionId: session,
    app: "blocked.exe",
    jpeg: bytes.toString("base64"),
  });
  const list = (
    await f.request(
      `/proctor/incidents?studentId=${device.id}&sessionId=${session}`,
      null,
      f.token,
    )
  ).data.events;
  const app = list.find((e) => e.category === "prohibited_application");
  assert.ok(app);
  assert.equal(app.detail.app, "blocked.exe");
  assert.equal(app.has_evidence, false);
  const teacher = await browser.newPage(),
    student = await browser.newPage();
  const errors = [];
  for (const page of [teacher, student])
    page.on("pageerror", (e) => errors.push(e.message));
  const launch = (await f.request("/student/launch", {}, device.token)).data
    .code;
  await student.goto(f.base + "/student#launch=" + launch);
  await student.getByRole("timer").waitFor();
  // Exercise the actual event handler and HTTP route with a labeled synthetic DOM exit.
  await student.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect
    .poll(async () =>
      (
        await f.request(
          `/proctor/incidents?studentId=${device.id}`,
          null,
          f.token,
        )
      ).data.events.some((e) => e.category === "window_blur"),
    )
    .toBeTruthy();
  assert.equal(
    (
      await f.request(
        "/student/proctor-event",
        { category: "window_blur" },
        device.token,
      )
    ).data.throttled,
    true,
  );
  await student.evaluate(() =>
    document.dispatchEvent(new Event("fullscreenchange")),
  );
  await expect
    .poll(async () =>
      (
        await f.request(
          `/proctor/incidents?studentId=${device.id}`,
          null,
          f.token,
        )
      ).data.events.some((e) => e.category === "fullscreen_exit"),
    )
    .toBeTruthy();
  await teacher.goto(f.base);
  await teacher.getByLabel("Email", { exact: true }).fill("exam@local.test");
  await teacher.getByLabel("Password", { exact: true }).fill(f.password);
  await teacher.getByRole("button", { name: "Sign in to ExamOS" }).click();
  await teacher.goto(
    f.base + `/#/incidents?studentId=${device.id}&sessionId=${session}`,
  );
  const phoneCard = teacher.locator(`[data-incident-id="${phone.id}"]`);
  await phoneCard
    .getByRole("button", { name: "Open incident details" })
    .click();
  await expect(
    teacher.getByRole("dialog", { name: "Incident details" }).locator("img"),
  ).toBeVisible();
  await teacher.getByRole("button", { name: "Close incident details" }).click();
  const appCard = teacher.locator(`[data-incident-id="${app.id}"]`);
  await appCard.getByRole("button", { name: "Open incident details" }).click();
  // Server and current consent must both permit the linked snapshot.
  await call("camera-consent", { sessionId: session, accept: false });
  assert.equal(
    (
      await f.request(
        `/proctor/devices/${device.id}/camera-check`,
        { incidentId: app.id },
        f.token,
      )
    ).status,
    409,
  );
  await call("camera-consent", {
    sessionId: session,
    accept: true,
    snapshots: false,
  });
  await call("camera-status", { sessionId: session, status: "active" });
  assert.equal(
    (
      await f.request(
        `/proctor/devices/${device.id}/camera-check`,
        { incidentId: app.id },
        f.token,
      )
    ).status,
    403,
  );
  await call("camera-consent", {
    sessionId: session,
    accept: true,
    snapshots: true,
  });
  await call("camera-status", { sessionId: session, status: "active" });
  assert.equal(
    (
      await f.request(
        `/proctor/devices/${device.id}/camera-check`,
        { incidentId: randomUUID() },
        f.token,
      )
    ).status,
    404,
  );
  let capture;
  socket.on("camera-check-request", (request, ack) => {
    ack({ ok: true });
    capture = new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
      call("proctor-event", {
        sessionId: session,
        category: "camera_check",
        requestId: request.requestId,
        clientEventId: randomUUID(),
        jpeg: bytes.toString("base64"),
      }),
    );
  });
  await teacher
    .getByRole("button", {
      name: "Request consented camera snapshot for this incident",
    })
    .click();
  await expect.poll(() => !!capture).toBeTruthy();
  const snapshot = await capture;
  assert.ok(snapshot.ok && snapshot.hasEvidence);
  await expect(
    teacher.getByRole("dialog", { name: "Incident details" }).locator("img"),
  ).toBeVisible({ timeout: 8000 });
  const detail = (await f.request(`/proctor/events/${app.id}`, null, f.token))
    .data;
  assert.equal(detail.relatedEvidence[0].id, snapshot.evidenceId);
  assert.equal(detail.has_evidence, false); // The source record has not been rewritten.
  assert.equal(
    (await f.request(`/sessions/${session}/exam-status`, null, f.token)).data
      .controls.length,
    0,
  );
  await teacher.getByRole("button", { name: "Close incident details" }).click();
  await appCard
    .getByLabel("Review note Policy student")
    .fill("Reviewed observable app policy event; ignore");
  await appCard.getByLabel("Decision").selectOption("dismissed");
  await appCard
    .getByRole("button", { name: "Save observation review" })
    .click();
  await expect(appCard.locator(".badge")).toHaveText("dismissed");
  await teacher
    .getByRole("link", { name: "Examinations", exact: true })
    .click();
  const row = teacher.locator("#exam-progress tbody tr").filter({
    has: teacher.getByRole("cell", { name: "Policy student", exact: true }),
  });
  await row.getByRole("button", { name: "Pause exam", exact: true }).click();
  await row
    .getByLabel("Control reason for Policy student")
    .fill("Human review of window exit");
  await row.getByRole("button", { name: "Confirm pause", exact: true }).click();
  await expect(
    student.getByText("Your exam has been paused for invigilator review.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 8000 });
  await row.getByRole("button", { name: "End this exam", exact: true }).click();
  await row
    .getByLabel("Control reason for Policy student")
    .fill("Human decision after review");
  await row.getByRole("button", { name: "Confirm end", exact: true }).click();
  await expect(
    student.getByText("Your exam has been ended by the invigilator", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 8000 });
  assert.equal(
    (await f.request("/student/exam", null, device.token)).data.attempt
      .submission_reason,
    "teacher_ended",
  );
  assert.equal(
    (await f.request(`/sessions/${session}/exam-status`, null, f.token)).data
      .controls.length,
    2,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: authenticated phone fixture + app sample + DOM exit -> flags -> protected/linked consented snapshots -> dismiss -> human pause/end. Camera/model and DOM observations are explicitly synthetic.",
  );
} finally {
  clearInterval(heartbeat);
  socket?.disconnect();
  await browser.close();
  await f.close();
}

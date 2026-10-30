import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";
import jpeg from "jpeg-js";
import { mkdir } from "node:fs/promises";
const f = await fixture();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.EXAMOS_TEST_BROWSER
    ? { channel: process.env.EXAMOS_TEST_BROWSER }
    : {}),
});
try {
  const paper = (
    await f.request(
      "/papers",
      uploadForm(await actualPaper(), { durationMinutes: "5" }),
      f.token,
    )
  ).data.id;
  const session = (
    await f.request("/sessions", { name: "Human review session" }, f.token)
  ).data.id;
  await f.request(`/sessions/${session}/paper`, { paperId: paper }, f.token);
  const one = await f.enroll("Review student"),
    two = await f.enroll("Unaffected student");
  const x = (await f.request("/student/exam/start", {}, one.token)).data;
  await f.request("/student/exam/start", {}, two.token);
  const incident = randomUUID(),
    asset = randomUUID();
  // Explicit codec fixture: proves protected rendering, not real camera detection.
  const bytes = jpeg.encode(
    { width: 2, height: 2, data: Buffer.alloc(16, 255) },
    50,
  ).data;
  await f.db.query(
    "INSERT INTO proctor_events(id,teacher_id,session_id,device_id,attempt_id,category,detail,observed_at,evidence,evidence_expires_at) VALUES ($1,$2,$3,$4,$5,'phone_detected',$6,now(),$7,now()+interval '1 day')",
    [
      incident,
      f.teacher,
      session,
      one.id,
      x.id,
      JSON.stringify({
        interpretation: "Codec fixture only; not a real camera incident.",
      }),
      bytes,
    ],
  );
  await f.db.query(
    "INSERT INTO evidence_assets(id,event_id,teacher_id,student_id,session_id,examination_id,kind,mime_type,storage_location,captured_at,byte_size,expires_at) VALUES ($1,$2,$3,$4,$5,$6,'snapshot','image/jpeg','test-codec-fixture',now(),$7,now()+interval '1 day')",
    [asset, incident, f.teacher, one.id, session, x.id, bytes.length],
  );
  const teacher = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    student = await browser.newPage();
  const errors = [];
  for (const page of [teacher, student])
    page.on("pageerror", (e) => errors.push(e.message));
  await teacher.goto(f.base);
  await teacher.getByLabel("Email", { exact: true }).fill("exam@local.test");
  await teacher.getByLabel("Password", { exact: true }).fill(f.password);
  await teacher.getByRole("button", { name: "Sign in to ExamOS" }).click();
  await teacher
    .getByRole("link", { name: "Examinations", exact: true })
    .click();
  const row = teacher.locator("#exam-progress tbody tr").filter({
    has: teacher.getByRole("cell", { name: "Review student", exact: true }),
  });
  await expect(teacher.locator("#exam-progress tbody tr")).toHaveCount(2);
  await teacher
    .getByLabel("Only students with pending incidents or app alerts")
    .check();
  await expect(teacher.locator("#exam-progress tbody tr")).toHaveCount(1);
  await row
    .getByRole("button", { name: "Review student incidents and evidence" })
    .click();
  await teacher.getByRole("button", { name: "Open incident details" }).click();
  await expect(
    teacher.getByRole("dialog", { name: "Incident details" }).locator("img"),
  ).toBeVisible();
  await teacher.getByRole("button", { name: "Close incident details" }).click();
  const card = teacher
    .locator(".proctor-event")
    .filter({ hasText: "Review student" });
  await card
    .getByLabel("Review note Review student")
    .fill("Reviewed codec fixture; ignore");
  await card.getByLabel("Decision").selectOption("dismissed");
  await card.getByRole("button", { name: "Save observation review" }).click();
  await expect(card.locator(".badge")).toHaveText("dismissed");
  await teacher
    .getByRole("link", { name: "Examinations", exact: true })
    .click();
  await teacher
    .getByLabel("Only students with pending incidents or app alerts")
    .uncheck();
  const launch = (await f.request("/student/launch", {}, one.token)).data.code;
  await student.goto(f.base + "/student#launch=" + launch);
  const input = student.getByLabel("Your text response (optional)");
  await input.fill("Preserved answer");
  await expect(
    student.getByText("Response saved", { exact: true }),
  ).toBeVisible();
  const control = async (action, reason) => {
    const name =
      action === "pause"
        ? "Pause exam"
        : action === "resume"
          ? "Resume exam"
          : "End this exam";
    await row.getByRole("button", { name, exact: true }).click();
    await row.getByLabel("Control reason for Review student").fill(reason);
    await row
      .getByRole("button", { name: "Confirm " + action, exact: true })
      .click();
  };
  await control("pause", "Invigilator reviewing reported event");
  await expect(
    student.getByText("Your exam has been paused for invigilator review.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 8000 });
  await expect(input).toHaveAttribute("readonly", "");
  await expect(
    student.getByRole("button", { name: "Submit examination", exact: true }),
  ).toBeDisabled();
  const deadline = (await f.request("/student/exam", null, one.token)).data
    .attempt.deadline_at;
  assert.equal(deadline, x.deadline_at);
  await student.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await student.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Student pause view overflows on mobile",
  );
  await teacher.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await teacher.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Teacher control view overflows on mobile",
  );
  await teacher.setViewportSize({ width: 1440, height: 1000 });
  await student.setViewportSize({ width: 1280, height: 720 });
  const output = process.env.EXAMOS_TEST_ARTIFACT_DIR;
  if (output) {
    await mkdir(output, { recursive: true });
    await student.screenshot({
      path: output + "/student-paused.png",
      fullPage: true,
    });
    await teacher.screenshot({
      path: output + "/review-controls.png",
      fullPage: true,
    });
  }
  await student.reload();
  await expect(
    student.getByText("Your exam has been paused for invigilator review.", {
      exact: true,
    }),
  ).toBeVisible();
  await control("resume", "Review complete; continue");
  await expect(input).not.toHaveAttribute("readonly", "");
  await input.fill("Answer after resume");
  await expect(
    student.getByText("Response saved", { exact: true }),
  ).toBeVisible();
  await control("end", "Manual end after review");
  await expect(
    student.getByText("Your exam has been ended by the invigilator", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 8000 });
  await expect(row).toContainText("teacher_ended");
  assert.equal(
    (await f.request("/student/exam", null, two.token)).data.attempt.status,
    "started",
  );
  assert.equal(
    (await f.request("/student/exam", null, one.token)).data.attempt.answers,
    "Answer after resume",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: progress/flag filter, scoped incident review, protected codec evidence, dismiss, pause/reload/resume/end UI and student isolation. No actual camera used.",
  );
} finally {
  await browser.close();
  await f.close();
}

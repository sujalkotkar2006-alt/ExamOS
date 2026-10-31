import { chromium, expect } from "@playwright/test";
import { fixture, actualPaper } from "./exam-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const f = await fixture();
await actualPaper();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const teacher = await context.newPage(),
  errors = [];
teacher.on("pageerror", (e) => errors.push(e.message));
let student, studentContext;
try {
  await teacher.goto(f.base);
  await teacher.getByLabel("Email", { exact: true }).fill("exam@local.test");
  await teacher.getByLabel("Password", { exact: true }).fill(f.password);
  await teacher.getByRole("button", { name: "Sign in to ExamOS" }).click();
  await teacher.getByRole("heading",{name:"Dashboard",exact:true}).waitFor();
  await teacher.getByRole("link",{name:"Examinations",exact:true}).click();
  await teacher
    .getByRole("heading", { name: "Question Papers", exact: true })
    .waitFor();
  await teacher
    .getByLabel("Paper title", { exact: true })
    .fill("Algebra browser examination");
  await teacher.getByLabel("Subject", { exact: true }).fill("Mathematics");
  await teacher.getByLabel("Total marks", { exact: true }).fill("20");
  await teacher
    .getByLabel("Exam duration (minutes)", { exact: true })
    .fill("1");
  await teacher
    .getByLabel("Question paper PDF", { exact: true })
    .setInputFiles("tests/fixtures/mathematics-question-paper.pdf");
  await teacher
    .getByRole("button", { name: "Upload question paper", exact: true })
    .click();
  await teacher
    .getByText("Question paper uploaded.", { exact: true })
    .waitFor();
  await teacher
    .getByRole("button", { name: "Preview PDF", exact: true })
    .click();
  await teacher
    .locator('.paper-preview canvas[data-rendered="true"]')
    .waitFor();
  await teacher.getByRole("button", { name: "Close PDF preview" }).click();
  await teacher
    .getByLabel("Examination name", { exact: true })
    .fill("Browser PDF workflow");
  await teacher
    .getByRole("button", { name: "Start session", exact: false })
    .click();
  await teacher
    .getByLabel("Assign paper", { exact: true })
    .selectOption({ label: "Algebra browser examination" });
  await teacher
    .getByLabel("Examination session", { exact: true })
    .selectOption({ label: "Browser PDF workflow" });
  await teacher
    .getByRole("button", { name: "Assign paper to session", exact: true })
    .click();
  await teacher.getByText("Paper assigned.", { exact: false }).waitFor();
  await teacher.getByRole("button", { name: "Enroll a device" }).click();
  const code = await teacher.locator("code").textContent();
  const enrolled = (
    await f.request("/enroll", { name: "Browser enrolled student", code })
  ).data;
  assert.ok(enrolled.token);
  const activeSession = (await f.request("/state", null, f.token)).data.sessions.find(s => s.status === "active");
  await f.monitor(enrolled, activeSession.id);
  const launch = (await f.request("/student/launch", {}, enrolled.token)).data;
  studentContext = await browser.newContext({
    viewport: { width: 1100, height: 1000 },
  });
  student = await studentContext.newPage();
  student.on("pageerror", (e) => errors.push(e.message));
  await student.goto(f.base + "/student#launch=" + launch.code);
  await student
    .getByRole("heading", { name: "Algebra browser examination", exact: true })
    .waitFor();
  await student.locator('canvas[data-rendered="true"]').waitFor();
  assert.ok(
    !student.url().includes("launch="),
    "Launch credential must be removed from the address bar",
  );
  await expect(teacher.locator("#exam-progress")).toContainText("Paper opened");
  await student
    .getByRole("button", { name: "Start examination", exact: true })
    .click();
  await student.getByRole("timer").waitFor();
  const first = await student.getByRole("timer").textContent();
  await student.waitForTimeout(2400);
  assert.notEqual(
    await student.getByRole("timer").textContent(),
    first,
    "Countdown did not advance",
  );
  await expect(teacher.locator("#exam-progress")).toContainText(
    "Taking examination",
  );
  await student
    .getByLabel("Your text response (optional)", { exact: true })
    .fill("1. x = 6\n2. 40 square centimetres");
  await expect(student.getByRole("status")).toContainText("Response saved");
  await mkdir("artifacts", { recursive: true });
  await student.screenshot({
    path: "artifacts/student-examination.png",
    fullPage: true,
  });
  await teacher.screenshot({
    path: "artifacts/teacher-examination-progress.png",
    fullPage: true,
  });
  await student.setViewportSize({width:390,height:844});
  assert.ok(await student.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Student mobile layout overflows horizontally');
  await student.screenshot({path:'artifacts/student-examination-mobile.png',fullPage:true});
  await student.setViewportSize({width:1100,height:1000});
  await student
    .getByRole("button", { name: "Submit examination", exact: true })
    .click();
  await student.getByText("Examination submitted", { exact: true }).waitFor();
  await expect(teacher.locator("#exam-progress")).toContainText("Submitted");
  await teacher.getByText("View response", { exact: true }).click();
  await expect(teacher.locator(".answer-review")).toContainText("x = 6");
  await student.reload();
  await student.getByText("Examination submitted", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Chromium teacher login, actual file upload/preview/assignment, enrollment, student PDF rendering, advancing countdown, saved response, submission receipt persistence and teacher status/response.",
  );
} finally {
  await browser.close();
  await f.close();
}

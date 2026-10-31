import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";
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
    await f.request("/sessions", { name: "Failure recovery" }, f.token)
  ).data.id;
  await f.request(`/sessions/${session}/paper`, { paperId: paper }, f.token);
  const device = await f.enroll();
  await f.monitor(device, session);
  const launch = (await f.request("/student/launch", {}, device.token)).data
    .code;
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.base + "/student#launch=" + launch);
  await page
    .getByRole("button", { name: "Start examination", exact: true })
    .click();
  const input = page.getByLabel("Your text response (optional)");
  await input.waitFor();
  let failed = false;
  await page.route("**/api/student/exam/save", async (route) => {
    if (!failed) {
      failed = true;
      await route.abort();
    } else await route.continue();
  });
  await input.fill("retry without another keystroke");
  await expect(page.getByText("Response saved", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  assert.ok(failed);
  await page.unroute("**/api/student/exam/save");
  await input.fill("reload before debounce");
  await page.reload();
  await expect(input).toHaveValue("reload before debounce");
  await expect(page.getByText("Response saved", { exact: true })).toBeVisible();
  let dropped = false;
  await page.route("**/api/student/exam/save", async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await input.fill("acknowledgement lost");
  await expect(page.getByText("Response saved", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.unroute("**/api/student/exam/save");
  for (let i = 0; i < 14; i++) {
    await input.fill("continuous " + i);
    await page.waitForTimeout(400);
  }
  const mid = (await f.request("/student/exam", null, device.token)).data
    .attempt;
  assert.match(mid.answers, /continuous/);
  await expect(page.getByText("Response saved", { exact: true })).toBeVisible();
  // A different page writes a newer revision: this tab must stop, not overwrite it.
  const current = (await f.request("/student/exam", null, device.token)).data
    .attempt;
  await f.request(
    "/student/exam/save",
    {
      answers: "other tab accepted response",
      revision: current.answer_revision,
      mutationId: crypto.randomUUID(),
    },
    device.token,
  );
  await input.fill("this tab unsent response");
  await expect(
    page.getByRole("button", { name: "Use server response" }),
  ).toBeVisible();
  await expect(input).toHaveValue("this tab unsent response");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Use server response" }).click();
  await expect(input).toHaveValue("other tab accepted response");
  let submitDropped = false;
  await page.route("**/api/student/exam/submit", async (route) => {
    submitDropped = true;
    await route.fetch();
    await route.abort();
  });
  await page
    .getByRole("button", { name: "Submit examination", exact: true })
    .click();
  await expect(
    page.getByText("Examination submitted", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  assert.ok(submitDropped);
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((k) => k.startsWith("examos-draft:"))
          .length,
    ),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: retry without typing, reload draft recovery, lost save acknowledgement, continuous typing maximum interval, lost submit acknowledgement and completion cleanup.",
  );
} finally {
  await browser.close();
  await f.close();
}

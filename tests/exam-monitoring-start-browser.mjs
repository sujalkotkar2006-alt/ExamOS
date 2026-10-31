import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";

const f = await fixture();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.EXAMOS_TEST_BROWSER ? { channel: process.env.EXAMOS_TEST_BROWSER } : {}) });
  const paper = (await f.request("/papers", uploadForm(await actualPaper()), f.token)).data.id;
  const session = (await f.request("/sessions", { name: "Monitored admission browser check" }, f.token)).data.id;
  await f.request(`/sessions/${session}/paper`, { paperId: paper }, f.token);
  const device = await f.enroll();
  const launch = (await f.request("/student/launch", {}, device.token)).data.code;
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(f.base + "/student#launch=" + launch);
  const start = page.getByRole("button", { name: "Start examination", exact: true });
  await expect(start).toBeDisabled();
  await expect(page.getByText("Screen monitoring is required before you can start.", { exact: false })).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  const first = await f.monitor(device, session);
  await expect(start).toBeEnabled({ timeout: 10000 });
  await page.locator('canvas[data-rendered="true"]').waitFor();
  first.stop();
  await expect(start).toBeDisabled({ timeout: 10000 });
  const second = await f.monitor(device, session);
  await expect(start).toBeEnabled({ timeout: 10000 });
  await start.click();
  await page.getByRole("timer").waitFor();
  second.stop();
  await page.getByLabel("Your text response (optional)").fill("Retained after monitoring disconnect");
  await expect(page.getByLabel("Your text response (optional)")).toHaveValue("Retained after monitoring disconnect");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/exam-monitoring-start.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: unmonitored start disabled, clear notice, PDF withheld; fresh protocol monitoring enables start; disconnect disables admission; a started attempt retains answer access. No physical capture.");
} finally {
  await browser?.close();
  await f.close();
}

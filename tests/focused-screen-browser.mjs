import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { io } from "socket.io-client";
import jpeg from "jpeg-js";
import assert from "node:assert/strict";
import { fixture } from "./exam-fixture.mjs";
const f = await fixture(),
  browser = await chromium.launch({ headless: true }),
  page = await browser.newPage(),
  clients = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let heartbeat;
try {
  const sid = (
    await f.request("/sessions", { name: "Focused screen UI fixture" }, f.token)
  ).data.id;
  // Codec-only UI fixture, never claimed as a real student's screen or webcam photograph.
  const encoded = jpeg
    .encode({ width: 4, height: 4, data: Buffer.alloc(4 * 4 * 4, 180) }, 60)
    .data.toString("base64");
  const devices = [];
  for (const name of ["Alpha protocol fixture", "Beta protocol fixture"]) {
    const d = await f.enroll(name),
      s = io(f.base, { auth: { token: d.token }, reconnection: false });
    clients.push(s);
    await new Promise((resolve, reject) => {
      s.once("connect", resolve);
      s.once("connect_error", reject);
    });
    await s.timeout(3000).emitWithAck("heartbeat", {});
    await s
      .timeout(3000)
      .emitWithAck("consent", { sessionId: sid, accept: true });
    devices.push({ d, s });
  }
  heartbeat = setInterval(() => {
    for (const { s } of devices) s.emit("heartbeat", {}, () => {});
  }, 2000);
  await page.goto(f.base);
  await page.getByLabel("Email", { exact: true }).fill("exam@local.test");
  await page.getByLabel("Password", { exact: true }).fill(f.password);
  await page.getByRole("button", { name: "Sign in to ExamOS" }).click();
  await page
    .getByRole("link", { name: "Live Proctoring", exact: true })
    .click();
  await expect(page.locator(".device")).toHaveCount(2);
  const send = async (index, app) =>
    devices[index].s
      .timeout(3000)
      .emitWithAck("sample", { sessionId: sid, app, jpeg: encoded });
  await send(0, "alpha-fixture.exe");
  await send(1, "beta-fixture.exe");
  await expect(page.locator(".device img")).toHaveCount(2);
  const trigger = page.getByRole("button", {
    name: "Inspect screen of Alpha protocol fixture",
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Alpha protocol fixture" });
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "alt",
    "Consented screen of Alpha protocol fixture",
  );
  await expect(dialog).toContainText(devices[0].d.id);
  await expect(dialog).toContainText(sid);
  await expect(dialog).toContainText("Received");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/p1-focused-desktop.png" });
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("dialog", { name: "Beta protocol fixture" }),
  ).toContainText("beta-fixture.exe");
  await page.keyboard.press("ArrowLeft");
  await expect(dialog).toContainText("alpha-fixture.exe");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.getByLabel("Find student", { exact: true }).fill(devices[1].d.id);
  await expect(page.locator(".device")).toHaveCount(1);
  await expect(page.locator(".device")).toContainText("Beta");
  await page
    .getByLabel("Find student", { exact: true })
    .fill("no such fixture");
  await expect(
    page.getByText("No students match these filters."),
  ).toBeVisible();
  await page.getByLabel("Find student", { exact: true }).fill("");
  await trigger.click();
  await expect(dialog.getByRole("img")).toHaveCount(0, { timeout: 12000 });
  await expect(dialog).toContainText("No current screen preview");
  await send(0, "alpha-fresh-fixture.exe");
  await expect(dialog.getByRole("img")).toHaveCount(1);
  await expect(dialog).toContainText("alpha-fresh-fixture.exe");
  await page.waitForTimeout(1600);
  await devices[0].s
    .timeout(3000)
    .emitWithAck("sample", {
      sessionId: sid,
      app: "alpha-fixture.exe",
      jpeg: "/9j/bm90LWltYWdl",
    });
  await expect(dialog).toContainText("Preview unavailable");
  await expect(dialog.getByRole("img")).toHaveCount(0);
  await page.waitForTimeout(1600);
  await send(0, "recovered-fixture.exe");
  await expect(dialog.getByRole("img")).toHaveCount(1);
  await expect(dialog).toContainText("recovered-fixture.exe");

  await devices[0].s
    .timeout(3000)
    .emitWithAck("consent", { sessionId: sid, accept: false });
  await expect(dialog.getByRole("img")).toHaveCount(0);
  await expect(dialog).toContainText("Monitoring stopped");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "artifacts/p1-focused-mobile.png" });
  await page.keyboard.press("Escape");
  await page
    .getByLabel("Screen status", { exact: true })
    .selectOption("attention");
  await expect(page.locator(".device")).toHaveCount(2);
  devices[1].s.disconnect();
  await expect(
    page.locator('.device[data-device-id="' + devices[1].d.id + '"] img'),
  ).toHaveCount(0);
  await f.request("/sessions/" + sid + "/end", {}, f.token);
  await expect(page.locator(".device img")).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: two protocol fixtures, focused session/device identity, fresh updates, expiry, withdrawal/end/disconnect clearing, filters, keyboard focus/navigation and mobile overflow. Physical multi-device acceptance is separate.",
  );
} finally {
  clearInterval(heartbeat);
  for (const s of clients) s.disconnect();
  await browser.close();
  await f.close();
}

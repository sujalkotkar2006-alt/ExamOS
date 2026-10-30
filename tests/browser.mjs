import { chromium } from "@playwright/test";
import {testDatabase} from "./test-database.mjs";
import http from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import assert from "node:assert/strict";
import { migrate } from "../server/db.js";
import { createApp } from "../server/app.js";
import { mkdir } from "node:fs/promises";
const db = await testDatabase();
await migrate(db);
const password = randomBytes(20).toString("hex");
await db.query("INSERT INTO teachers VALUES ($1,$2,$3)", [
  randomUUID(),
  "browser@examos.local",
  await bcrypt.hash(password, 4),
]);
const { app, attach, drain } = createApp(db, randomBytes(48).toString("hex"));
const server = http.createServer(app),
  live = attach(server);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.getByLabel("Email", { exact: true }).fill("browser@examos.local");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to ExamOS" }).click();
  await page
    .getByRole("heading", { name: "Dashboard", exact:true })
    .waitFor();
  await page.getByRole("button", { name: "Enroll a device" }).click();
  await page.getByText("One-use enrollment code").waitFor();
  const code = await page.locator("code").textContent();
  assert.equal(code.length, 24);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link",{name:"Examinations",exact:true}).click();
  await page.getByLabel("Examination name").fill("Browser workflow validation");
  await page.getByLabel("Allowed executable names").fill("exam.exe");
  await page.getByRole("button", { name: "Start session" }).click();
  await page
    .getByRole("button", { name: "End session & stop monitoring" })
    .waitFor();
  await page.getByText("No application restrictions", { exact: false }).count();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/dashboard-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "End session & stop monitoring" })
    .click();
  await page.getByRole("heading", { name: "Start an examination" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "artifacts/dashboard-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile horizontal overflow",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in to ExamOS" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real Chromium login, enrollment code, create/end session, responsive layout, logout; no page errors.",
  );
} finally {
  await browser.close();
  await new Promise((r) => live.close(r));
  server.close();
  await drain();
  await db.close();
}

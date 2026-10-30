import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import bcrypt from "bcryptjs";
import net from "node:net";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { migrate } from "../server/db.js";
if (process.env.EXAMOS_NATIVE_TEST_APPROVED !== "visible-screen-lifecycle")
  throw Error("Native screen acceptance opt-in required");
const directory = resolve("data/tmp/native-restart-" + randomUUID());
await mkdir(directory, { recursive: true });
const data = resolve(directory, "postgres"),
  secret = randomBytes(48).toString("hex"),
  password = randomBytes(24).toString("hex");
const db = new PGlite(data);
await migrate(db);
await db.query("INSERT INTO teachers VALUES ($1,$2,$3)", [
  randomUUID(),
  "native-restart@test.local",
  await bcrypt.hash(password, 4),
]);
await db.close();
const reserve = net.createServer();
await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
const port = reserve.address().port;
await new Promise((r) => reserve.close(r));
const base = "http://127.0.0.1:" + port,
  controlSecret = randomBytes(24).toString("hex");
let backend, native, timeout;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function start() {
  backend = spawn(process.execPath, ["server/index.js"], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      EXAMOS_LOCAL_DB: "1",
      EXAMOS_DATA_DIR: data,
      JWT_SECRET: secret,
      HOST: "127.0.0.1",
      PORT: String(port),
      TLS_CERT: "",
      TLS_KEY: "",
    },
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    if (backend.exitCode !== null) throw Error("Test backend exited");
    await pause(100);
  }
  throw Error("Restart readiness timed out");
}
async function stop() {
  if (backend && backend.exitCode === null) {
    const exited = new Promise((r) => backend.once("exit", r));
    backend.kill();
    await exited;
  }
}
const control = http.createServer(async (req, res) => {
  try {
    if (
      req.method !== "POST" ||
      req.headers["x-test-control"] !== controlSecret
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.url === "/stop") await stop();
    else if (req.url === "/start") await start();
    else throw Error("Unknown test control");
    res.end("{}");
  } catch {
    res.writeHead(500);
    res.end("Isolated restart failed");
  }
});
await new Promise((r) => control.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage();
try {
  await start();
  await page.goto(base);
  await page
    .getByLabel("Email", { exact: true })
    .fill("native-restart@test.local");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to ExamOS" }).click();
  await page
    .getByRole("link", { name: "Live Proctoring", exact: true })
    .click();
  native = spawn(
    ".venv/Scripts/python.exe",
    ["-u", "tests/windows_restart.py"],
    {
      windowsHide: false,
      stdio: "inherit",
      env: {
        ...process.env,
        EXAMOS_TEST_URL: base,
        EXAMOS_TEST_LOGIN: JSON.stringify({
          email: "native-restart@test.local",
          password,
        }),
        EXAMOS_CONFIG_PATH: resolve(directory, "device.dat"),
        EXAMOS_RESTART_CONTROL: "http://127.0.0.1:" + control.address().port,
        EXAMOS_RESTART_SECRET: controlSecret,
      },
    },
  );
  const exited = new Promise((r) => native.once("exit", r));
  timeout = setTimeout(() => native.kill(), 90000);
  await expect(page.locator(".device img")).toHaveCount(1, { timeout: 20000 });
  await expect(page.locator(".device img")).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator(".device img")).toHaveCount(1, { timeout: 35000 });
  assert.equal(await exited, 0);
  await expect(page.locator(".device img")).toHaveCount(0);
  console.log(
    "PASS: actual backend process restart cleared the teacher preview; actual native capture resumed only after manual reconnect, new session and fresh consent.",
  );
} finally {
  clearTimeout(timeout);
  if (native?.exitCode === null) native.kill();
  await browser.close();
  await stop();
  control.close();
}

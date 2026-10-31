// Two local origins exercise the cloud topology without touching a live exam.
import { chromium, expect } from "@playwright/test";
import { build } from "vite";
import express from "express";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, actualPaper, uploadForm } from "./exam-fixture.mjs";

const deployment = {};
const f = await fixture({ deployment });
let browser, frontend;
try {
  const output = path.resolve("data/cloud-browser-" + randomUUID());
  process.env.VITE_BACKEND_ORIGIN = f.base;
  await build({ root: "dashboard", build: { outDir: output }, logLevel: "warn" });
  const app = express();
  app.get("/student", (req, res) => res.sendFile(path.join(output, "index.html")));
  app.use(express.static(output));
  frontend = http.createServer(app);
  await new Promise(resolve => frontend.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + frontend.address().port;
  deployment.appOrigin = origin;
  deployment.backendOrigin = f.base;
  browser = await chromium.launch({ headless: true, ...(process.env.EXAMOS_TEST_BROWSER ? { channel: process.env.EXAMOS_TEST_BROWSER } : {}) });
  const teacher = await browser.newPage();
  const errors = [];
  teacher.on("pageerror", e => errors.push(e.message));
  await teacher.goto(origin);
  await teacher.getByLabel("Email", { exact: true }).fill("exam@local.test");
  await teacher.getByLabel("Password", { exact: true }).fill(f.password);
  await teacher.getByRole("button", { name: "Sign in to ExamOS" }).click();
  await expect(teacher.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(teacher.getByText("Live connection", { exact: true })).toBeVisible();
  const paper = (await f.request("/papers", uploadForm(await actualPaper()), f.token)).data.id;
  const session = (await f.request("/sessions", { name: "Split-origin pilot acceptance" }, f.token)).data.id;
  await f.request(`/sessions/${session}/paper`, { paperId: paper }, f.token);
  const device = await f.enroll();
  const launch = (await f.request("/student/launch", {}, device.token)).data.code;
  const student = await browser.newPage();
  student.on("pageerror", e => errors.push(e.message));
  // Existing EXE opens the backend URL. Redirect must preserve the one-use fragment.
  await student.goto(f.base + "/student#launch=" + launch);
  const start = student.getByRole("button", { name: "Start examination", exact: true });
  await expect(start).toBeDisabled();
  if (new URL(student.url()).origin !== origin) throw Error("Student was not redirected to frontend");
  await f.monitor(device, session);
  await expect(start).toBeEnabled({ timeout: 10000 });
  await start.click();
  await student.getByRole("timer").waitFor();
  await student.locator('canvas[data-rendered="true"]').waitFor();
  await student.getByLabel("Your text response (optional)").fill("Cross-origin saved response");
  await student.getByRole("button", { name: "Submit examination", exact: true }).click();
  await expect(student.getByText("Examination submitted", { exact: true })).toBeVisible();
  const receipt = (await f.request("/student/exam", null, device.token)).data.attempt;
  if (receipt.answers !== "Cross-origin saved response" || receipt.status !== "submitted") throw Error("Cross-origin response not retained");
  if (errors.length) throw Error(errors.join("\n"));
  console.log("PASS: split-origin browser login, direct authenticated Socket.IO, backend-to-frontend launch redirect with fragment, monitored start, protected PDF and saved submission. Local HTTP loopback protocol fixture only; not hosted-provider acceptance.");
} finally {
  await browser?.close();
  if (frontend) await new Promise(resolve => frontend.close(resolve));
  await f.close();
}

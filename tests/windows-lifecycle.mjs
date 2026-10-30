import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {testDatabase} from "./test-database.mjs";
import { migrate } from "../server/db.js";
import { createApp } from "../server/app.js";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
if(process.env.EXAMOS_NATIVE_TEST_APPROVED!=='visible-screen-lifecycle') throw Error('Explicit native screen acceptance required');
const db = await testDatabase();
await migrate(db);
const email = "validation@examos.local",
  password = randomBytes(24).toString("hex");
await db.query("INSERT INTO teachers VALUES ($1,$2,$3)", [
  randomUUID(),
  email,
  await bcrypt.hash(password, 4),
]);
const { app, attach, drain } = createApp(db, randomBytes(48).toString("hex"));
const server = http.createServer(app),
  live = attach(server);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const apiUrl = "http://127.0.0.1:" + server.address().port;
live.engine.opts.transports=['polling'];live.engine.opts.allowUpgrades=false;
const control=randomBytes(24).toString('hex');
let blocked=false;
const held=new Set();
const proxy=http.createServer((req,res)=>{
  const chunks=[];req.on('data',b=>chunks.push(b));
  req.on('end',()=>{
    const body=Buffer.concat(chunks);
    if(req.url==='/__test/transport' && req.headers['x-test-control']===control){
      blocked=JSON.parse(body).blocked;
      if(!blocked)for(const r of held)r.destroy();
      res.writeHead(200);res.end('{}');return;
    }
    if(blocked){held.add(res);res.on('close',()=>held.delete(res));return;}
    const upstream=http.request(apiUrl+req.url,{method:req.method,headers:{...req.headers,host:new URL(apiUrl).host}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res)});
    upstream.on('error',()=>{res.writeHead(502);res.end()});upstream.end(body);
  });
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+proxy.address().port;
const {mkdir}=await import('node:fs/promises');await mkdir('data/tmp',{recursive:true});

console.log(
  "Real Windows integration test server ready. Visible agent will open.",
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(apiUrl);
await page.getByLabel("Email", { exact: true }).fill(email);
await page.getByLabel("Password", { exact: true }).fill(password);
await page.getByRole("button", { name: "Sign in to ExamOS" }).click();
await page
  .getByRole("heading", { name: "Dashboard", exact:true })
  .waitFor();
await page.getByRole("link",{name:"Live Proctoring",exact:true}).click();
const child = spawn(".venv/Scripts/python.exe", ["-u","tests/windows_lifecycle.py"], {
  stdio: "inherit",
  env: {
    ...process.env,
    EXAMOS_TEST_URL: url,
    EXAMOS_TEST_API_URL:apiUrl,
    EXAMOS_TEST_CONTROL:control,
    EXAMOS_ISOLATED_CONFIG: (await import("node:path")).resolve("data/tmp/lifecycle-"+randomUUID()+".dat"),
    EXAMOS_TEST_LOGIN: JSON.stringify({ Email: email, Password: password }),
  },
});
const timeout = setTimeout(() => child.kill(), 240000);
const exited = new Promise((r) => child.on("exit", r));
let browserError;
try {
  await page.locator(".device img").waitFor({ timeout: 25000 });
  assert.ok(
    (await page.locator(".device img").getAttribute("src")).startsWith(
      "data:image/jpeg;base64,/9j/",
    ),
  );
  console.log(
    "PASS: React dashboard displayed the real Windows agent preview over Socket.IO.",
  );
  await expect(page.locator(".device img")).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator(".device")).toContainText("Monitoring stopped");

  console.log(
    "PASS: teacher preview cleared, stopped status displayed, and consent withdrawal recorded while device remained connected.",
  );
} catch (e) {
  browserError = e;
}
const code = await exited;
clearTimeout(timeout);
assert.equal(
  await page.locator(".device img").count(),
  0,
  "Preview must clear after session end",
);
await browser.close();
await new Promise((r) => live.close(r));
server.close();
await drain();
  await db.close();
for(const res of held)res.destroy();proxy.close();
process.exitCode = code ?? 1;
if (browserError) throw browserError;

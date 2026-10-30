import https from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import {testDatabase} from "./test-database.mjs";
import { migrate } from "../server/db.js";
import { createApp, hash } from "../server/app.js";
const python=process.env.EXAMOS_MEDIA_PYTHON || '.venv/Scripts/python.exe';
const certDirectory=resolve('data/tmp/tls-'+randomUUID());
execFileSync(python,['tests/create_tls_fixture.py',certDirectory]);
const db = await testDatabase();
await migrate(db);
const teacher = randomUUID(),
  token = randomBytes(32).toString("hex");
await db.query("INSERT INTO teachers VALUES ($1,$2,$3)", [
  teacher,
  "tls@test.local",
  "unused-test-hash",
]);
await db.query(
  "INSERT INTO devices(id,teacher_id,name,token_hash) VALUES ($1,$2,$3,$4)",
  [randomUUID(), teacher, "TLS transport test", hash(token)],
);
const { app, attach, drain } = createApp(db, randomBytes(48).toString("hex"));
const server = https.createServer(
    {
      cert: readFileSync(resolve(certDirectory,'server.crt')),
      key: readFileSync(resolve(certDirectory,'server.key')),
    },
    app,
  ),
  live = attach(server);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const expiredServer=https.createServer({cert:readFileSync(resolve(certDirectory,'expired.crt')),key:readFileSync(resolve(certDirectory,'expired.key'))},(req,res)=>res.end('never trusted'));
await new Promise(r=>expiredServer.listen(0,'127.0.0.1',r));
const child = spawn(python, ["tests/tls_client.py"], {
  stdio: "inherit",
  env: {
    ...process.env,
    EXAMOS_TLS_URL: "https://127.0.0.1:" + server.address().port,
    EXAMOS_TLS_CA: resolve(certDirectory,'ca.crt'),
    EXAMOS_EXPIRED_TLS_URL:'https://127.0.0.1:'+expiredServer.address().port,
    EXAMOS_TLS_DEVICE_TOKEN: token,
  },
});
const code = await new Promise((r) => child.on("exit", r));
await new Promise((r) => live.close(r));
server.close();
expiredServer.close();
await drain();
  await db.close();
process.exitCode = code ?? 1;

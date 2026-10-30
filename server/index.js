import "dotenv/config";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { database, migrate, closeDatabase } from "./db.js";
import { createApp } from "./app.js";
const db = await database();
await migrate(db);
// Invalidate sessions on restart: agents must receive fresh consent for a new session.
await db.query(
  "UPDATE sessions SET status='ended',ended_at=now() WHERE status='active'",
);
const { app, attach, drain } = createApp(db, process.env.JWT_SECRET);
const tls = process.env.TLS_CERT && process.env.TLS_KEY;
const host = process.env.HOST || "127.0.0.1";
if (!tls && !["127.0.0.1", "localhost", "::1"].includes(host))
  throw Error("TLS_CERT and TLS_KEY required for LAN binding");
const server = tls
  ? https.createServer(
      {
        cert: readFileSync(process.env.TLS_CERT),
        key: readFileSync(process.env.TLS_KEY),
      },
      app,
    )
  : http.createServer(app);
const io = attach(server);
server.listen(Number(process.env.PORT || 3000), host, () =>
  console.log(
    `ExamOS ${tls ? "https" : "http"}://${host}:${process.env.PORT || 3000}`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    io.emit("session", null);
    await db.query(
      "UPDATE sessions SET status='ended',ended_at=now() WHERE status='active'",
    );
    await new Promise(resolve=>io.close(resolve));
    server.close();
    await drain();
    await closeDatabase(db);
    process.exit(0);
  });

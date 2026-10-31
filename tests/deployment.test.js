import { test } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { deploymentConfig, publicOrigin } from "../server/deployment.js";
import { backendOrigin } from "../dashboard/src/backend.js";
import { fixture } from "./exam-fixture.mjs";

test("cloud hosting is explicit and only permits HTTPS public service origins", () => {
  assert.deepEqual(deploymentConfig({}), { appOrigin: "", backendOrigin: "", behindProxy: false });
  for (const bad of ["http://example.com", "https://example.com/api", "https://user:pass@example.com", "https://example.com?key=secret", "https://example.com/#launch=secret", "javascript:alert(1)"]) {
    assert.throws(() => publicOrigin(bad, "test"));
    assert.throws(() => backendOrigin(bad));
  }
  assert.equal(backendOrigin("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(deploymentConfig({ EXAMOS_BEHIND_PROXY: "1", PUBLIC_APP_URL: "https://exam.vercel.app", RENDER_EXTERNAL_URL: "https://exam.onrender.com" }).backendOrigin, "https://exam.onrender.com");
  assert.throws(() => deploymentConfig({ EXAMOS_BEHIND_PROXY: "1" }));
  assert.throws(() => deploymentConfig({ EXAMOS_BEHIND_PROXY: "1", PUBLIC_APP_URL: "https://exam.vercel.app", PUBLIC_BACKEND_URL: "https://exam.up.railway.app", EXAMOS_LOCAL_DB: "1" }));
});

test("cloud HTTP and Socket.IO origins preserve auth and trusted HTTPS boundaries", async () => {
  const deployment = deploymentConfig({ EXAMOS_BEHIND_PROXY: "1", PUBLIC_APP_URL: "https://exam.vercel.app", PUBLIC_BACKEND_URL: "https://exam.up.railway.app" });
  const f = await fixture({ deployment });
  const sockets = [];
  try {
    const preflight = await fetch(f.base + "/api/login", { method: "OPTIONS", headers: { Origin: deployment.appOrigin, "X-Forwarded-Proto": "https", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), deployment.appOrigin);
    assert.match(preflight.headers.get("vary"), /Origin/);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    assert.equal((await fetch(f.base + "/api/state", { headers: { Origin: "https://unapproved.vercel.app", "X-Forwarded-Proto": "https", Authorization: "Bearer " + f.token } })).status, 403);
    assert.equal((await fetch(f.base + "/api/state")).status, 400);
    assert.equal((await fetch(f.base + "/api/state", { headers: { Origin: deployment.appOrigin, "X-Forwarded-Proto": "https" } })).status, 401);
    assert.equal((await fetch(f.base + "/api/health")).status, 200);
    const query = f.db.query;
    try {
      f.db.query = async () => { throw Error("Isolated simulated database outage"); };
      const alive = await fetch(f.base + "/healthz", { headers: { "X-Forwarded-Proto": "https" } });
      assert.equal(alive.status, 200);
      assert.deepEqual(await alive.json(), { ok: true });
      assert.equal(alive.headers.get("cache-control"), "no-store");
      assert.notEqual((await fetch(f.base + "/api/health")).status, 200);
    } finally { f.db.query = query; }
    const redirect = await fetch(f.base + "/student", { redirect: "manual", headers: { "X-Forwarded-Proto": "https" } });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), deployment.appOrigin + "/student");
    for (const transport of ["websocket", "polling"]) {
      const connect = async (origin, token = f.token) => {
        const socket = io(f.base, { transports: [transport], reconnection: false, timeout: 3000, extraHeaders: { Origin: origin, "X-Forwarded-Proto": "https" }, auth: { role: "teacher", token } });
        sockets.push(socket);
        return new Promise(resolve => { socket.once("connect", () => resolve(true)); socket.once("connect_error", () => resolve(false)); });
      };
      assert.equal(await connect(deployment.appOrigin), true);
      assert.equal(await connect("https://unapproved.vercel.app"), false);
      assert.equal(await connect(deployment.appOrigin, "invalid"), false);
    }
  } finally { sockets.forEach(socket => socket.disconnect()); await f.close(); }
});

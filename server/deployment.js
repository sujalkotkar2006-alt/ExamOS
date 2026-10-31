// Cloud hosting is explicit; local/LAN certificate behavior remains the default.
export function publicOrigin(value, name) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { throw Error(`${name} must be a URL origin`); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw Error(`${name} must be an HTTPS origin without credentials, paths or query parameters (HTTP is allowed only on loopback)`);
  return url.origin;
}

export function deploymentConfig(env = process.env) {
  const appOrigin = publicOrigin(env.PUBLIC_APP_URL, "PUBLIC_APP_URL");
  const backendOrigin = publicOrigin(env.PUBLIC_BACKEND_URL || env.RENDER_EXTERNAL_URL, "PUBLIC_BACKEND_URL");
  const behindProxy = env.EXAMOS_BEHIND_PROXY === "1";
  if (behindProxy && (!appOrigin.startsWith("https:") || !backendOrigin.startsWith("https:")))
    throw Error("Proxy mode requires HTTPS PUBLIC_APP_URL and PUBLIC_BACKEND_URL");
  if (behindProxy && env.EXAMOS_LOCAL_DB === "1")
    throw Error("Cloud proxy mode requires persistent PostgreSQL, not a local PGlite database");
  return { appOrigin, backendOrigin, behindProxy };
}

export function originAllowed(origin, deployment, localOrigin) {
  return !origin || origin === deployment.appOrigin || origin === deployment.backendOrigin || origin === localOrigin;
}

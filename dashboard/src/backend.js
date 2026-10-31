export function backendOrigin(value = "") {
  if (!value) return "";
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw Error("VITE_BACKEND_ORIGIN must be an HTTPS origin; HTTP is allowed only on loopback");
  return url.origin;
}

// This is a public service address, never a database connection or credential.
export const BACKEND_ORIGIN = backendOrigin(import.meta.env?.VITE_BACKEND_ORIGIN || "");
export function apiFetch(path, options) {
  if (typeof path !== "string" || !path.startsWith("/api/"))
    throw Error("Expected an ExamOS API path");
  return globalThis.fetch(BACKEND_ORIGIN + path, options);
}

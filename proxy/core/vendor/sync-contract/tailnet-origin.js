export const TAILNET_CONTROL_PORT = "21436";
export const TAILNET_CSP_SOURCE = `https://*.ts.net:${TAILNET_CONTROL_PORT}`;
export const TAILNET_CONTROL_ORIGIN_LEASE_MS = 180_000;
export const TAILNET_CONTROL_ORIGIN_RENEW_MS = 60_000;

export function parseTailnetControlOrigin(raw) {
  if (typeof raw !== "string" || raw !== raw.trim() || raw.includes("\\")) return undefined;
  let url;
  try { url = new URL(raw); } catch { return undefined; }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port !== TAILNET_CONTROL_PORT || url.pathname !== "/" || url.search || url.hash
    || !hostname.endsWith(".ts.net") || hostname === "ts.net" || hostname.includes("..") || url.origin !== raw) return undefined;
  return url.origin;
}

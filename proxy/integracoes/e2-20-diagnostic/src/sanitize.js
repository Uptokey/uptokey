/** Redact canaries, auth, cookies, and private-key shapes before any persist/export/log. */
const AUTH_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;
const SECRET_SHAPE_RE =
  /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g;

export function createSanitizer(canaries = []) {
  const needles = canaries.filter(Boolean).map(String);

  function redactString(s) {
    let out = String(s);
    for (const c of needles) {
      if (c) out = out.split(c).join("[CANARY_REDACTED]");
    }
    out = out.replace(SECRET_SHAPE_RE, "[SECRET_SHAPE_REDACTED]");
    return out;
  }

  function sanitizeHeaders(headers = {}) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
      if (AUTH_HEADER_RE.test(k)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = redactString(Array.isArray(v) ? v.join("; ") : String(v ?? ""));
    }
    return out;
  }

  function sanitizeRecord(rec) {
    if (rec == null) return rec;
    if (typeof rec === "string") return redactString(rec);
    if (typeof rec !== "object") return rec;
    const out = { ...rec };
    if (out.headers) out.headers = sanitizeHeaders(out.headers);
    if (typeof out.body === "string") out.body = redactString(out.body);
    if (typeof out.error === "string") out.error = redactString(out.error);
    if (typeof out.detail === "string") out.detail = redactString(out.detail);
    return out;
  }

  function assertNoCanaryLeak(text) {
    const s = String(text);
    for (const c of needles) {
      if (c && s.includes(c)) return false;
    }
    if (/sk-[A-Za-z0-9_-]{12,}/.test(s)) return false;
    if (/Bearer\s+[A-Za-z0-9._\-]{8,}/.test(s)) return false;
    return true;
  }

  return { redactString, sanitizeHeaders, sanitizeRecord, assertNoCanaryLeak };
}

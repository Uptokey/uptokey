/**
 * Canonical public response contract for the Uptokey native account ceremony.
 *
 * Transports, browser opening, session interpretation and credentials remain
 * owned by their existing callers. This module only admits the bounded public
 * values shared by Tauri, the TUI, the PWA and embedded Uptokey surfaces.
 */

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOGIN_TTL_MS = 6 * 60_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function invalid() { throw new Error('account_response_invalid'); }
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
function nowValue(value) {
  const now = value === undefined ? Date.now() : value;
  if (!Number.isSafeInteger(now) || now < 0) invalid();
  return now;
}
function trustedOrigin(value) {
  if (value === undefined) return undefined;
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.origin !== value || url.username || url.password || url.search || url.hash ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) invalid();
  return url.origin;
}
function authorizeUrl(value, expectedOrigin) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.username || url.password || url.hash || url.pathname !== '/api/account/native/authorize' ||
      url.searchParams.getAll('id').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'id') ||
      !ACCOUNT_ID.test(url.searchParams.get('id') ?? '') ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)) ||
      expectedOrigin !== undefined && url.origin !== trustedOrigin(expectedOrigin)) invalid();
  return url.href;
}

export function readAccountLoginResponse(value, options = {}) {
  const row = record(value);
  if (row.session !== undefined) {
    if (Object.keys(row).some(key => key !== 'session')) invalid();
    return { session: row.session };
  }
  if (Object.keys(row).sort().join(',') !== 'expiresAt,loginUrl,userCode' ||
      typeof row.userCode !== 'string' || !/^[A-F0-9]{8}$/.test(row.userCode) ||
      !Number.isSafeInteger(row.expiresAt)) invalid();
  const now = nowValue(options.now), expiresAt = Number(row.expiresAt);
  if (expiresAt <= now || expiresAt > now + LOGIN_TTL_MS) invalid();
  return { loginUrl: authorizeUrl(row.loginUrl, options.expectedOrigin), userCode: row.userCode, expiresAt };
}

export function readAccountConnectionResponse(value, options = {}) {
  const row = record(value);
  if (Object.keys(row).sort().join(',') !== 'expiresAt,loginUrl' || !Number.isSafeInteger(row.expiresAt)) invalid();
  const expiresAt = Number(row.expiresAt);
  if (expiresAt <= nowValue(options.now)) invalid();
  return { loginUrl: authorizeUrl(row.loginUrl, options.expectedOrigin), expiresAt };
}

export function readAccountRetryAfter(value, now = Date.now()) {
  const seconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  const milliseconds = seconds !== undefined ? seconds * 1000 : Number.isFinite(date) ? date - now : 4000;
  return Math.min(360000, Math.max(4000, Number.isFinite(milliseconds) ? milliseconds : 4000));
}

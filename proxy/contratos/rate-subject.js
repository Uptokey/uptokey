import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const RATE_SUBJECT_HEADER = "x-uptokey-rate-subject";
export const RATE_TIMESTAMP_HEADER = "x-uptokey-rate-timestamp";
export const RATE_SIGNATURE_HEADER = "x-uptokey-rate-signature";

export function signRateSubject(clientIp, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  validateSecret(secret);
  if (typeof clientIp !== "string" || isIP(clientIp) === 0) throw new Error("invalid_client_ip");
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new Error("invalid_rate_timestamp");
  const subject = createHash("sha256").update(clientIp).digest("base64url");
  const timestamp = String(nowSeconds);
  const signature = signatureFor(subject, timestamp, secret);
  return { [RATE_SUBJECT_HEADER]: subject, [RATE_TIMESTAMP_HEADER]: timestamp, [RATE_SIGNATURE_HEADER]: signature };
}

export function verifyRateSubject(headers, secret, nowSeconds = Math.floor(Date.now() / 1000), maximumSkewSeconds = 60) {
  validateSecret(secret);
  const subject = headers.get(RATE_SUBJECT_HEADER), timestamp = headers.get(RATE_TIMESTAMP_HEADER), supplied = headers.get(RATE_SIGNATURE_HEADER);
  if (!subject || !/^[A-Za-z0-9_-]{43}$/.test(subject) || !timestamp || !/^\d{1,12}$/.test(timestamp) || !supplied || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return undefined;
  const parsed = Number(timestamp);
  if (!Number.isSafeInteger(parsed) || Math.abs(nowSeconds - parsed) > maximumSkewSeconds) return undefined;
  const expected = signatureFor(subject, timestamp, secret);
  const left = Buffer.from(supplied), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right) ? `bff:${subject}` : undefined;
}

function signatureFor(subject, timestamp, secret) { return createHmac("sha256", secret).update(`v1:${timestamp}:${subject}`).digest("base64url"); }
function validateSecret(secret) { if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) throw new Error("rate_subject_secret_too_short"); }

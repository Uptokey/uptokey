import { createHash } from "node:crypto";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { canonicalJson, envelopeChallengePayload } from "./canonical.js";
import { isDataRecord as dataRecord, projectStringArray } from "./plain-data.js";

export function envelopeChallenge(tenantId, envelope) {
  if (!safeId(tenantId) || !safeEnvelope(envelope)) throw new Error("webauthn_input_invalid");
  return createHash("sha256").update(envelopeChallengePayload(tenantId, envelope)).digest("base64url");
}

export async function verifyEnvelopeAssertion(input, verifyResponse = verifyAuthenticationResponse) {
  if (!dataRecord(input) || Object.keys(input).sort().join(",") !== "assertion,credential,envelope,expectedOrigin,expectedRPID,tenantId" || typeof verifyResponse !== "function") throw new Error("webauthn_input_invalid");
  const { assertion, credential, tenantId, envelope, expectedOrigin, expectedRPID } = input;
  const policy = validPolicy(expectedOrigin, expectedRPID);
  if (!policy || !safeId(tenantId) || !safeEnvelope(envelope) || !validCredential(credential) || !isAuthenticationResponse(assertion) || assertion.id !== credential.id) throw new Error("webauthn_assertion_invalid");
  const assertionProjection = structuredClone(assertion); const transportProjection = credential.transports ? projectStringArray(credential.transports, 8) : undefined;
  const verification = await verifyResponse({
    response: assertionProjection,
    expectedChallenge: envelopeChallenge(tenantId, envelope),
    expectedOrigin: policy.origins,
    expectedRPID: policy.rpID,
    credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, "base64url"), counter: credential.counter, ...(transportProjection ? { transports: transportProjection } : {}) },
    requireUserVerification: true
  });
  if (!dataRecord(verification) || verification.verified !== true || !dataRecord(verification.authenticationInfo) || verification.authenticationInfo.userVerified !== true) throw new Error("webauthn_assertion_rejected");
  const newCounter = verification.authenticationInfo.newCounter;
  if (!uint32(newCounter) || newCounter < credential.counter || credential.counter > 0 && newCounter === credential.counter) throw new Error("webauthn_assertion_rejected");
  return newCounter;
}

function isAuthenticationResponse(value) {
  if (!dataRecord(value) || Object.keys(value).some((key) => !["id", "rawId", "type", "clientExtensionResults", "response", "authenticatorAttachment"].includes(key))) return false;
  const response = value.response;
  return canonicalBase64url(value.id, 1, 2_048) && value.rawId === value.id && value.type === "public-key" && dataRecord(value.clientExtensionResults) && safeEnvelope(value.clientExtensionResults)
    && (value.authenticatorAttachment === undefined || value.authenticatorAttachment === "platform" || value.authenticatorAttachment === "cross-platform")
    && dataRecord(response) && Object.keys(response).some((key) => !["clientDataJSON", "authenticatorData", "signature", "userHandle"].includes(key)) === false
    && [response.clientDataJSON, response.authenticatorData, response.signature].every((field) => canonicalBase64url(field, 1, 65_536))
    && (response.userHandle === undefined || canonicalBase64url(response.userHandle, 0, 2_048));
}

function validCredential(value) {
  if (!dataRecord(value)) return false; const transports = value.transports === undefined ? undefined : projectStringArray(value.transports, 8);
  return Object.keys(value).sort().join(",") === (value.transports === undefined ? "counter,id,publicKey" : "counter,id,publicKey,transports")
    && canonicalBase64url(value.id, 1, 2_048) && canonicalBase64url(value.publicKey, 16, 4_096) && uint32(value.counter)
    && (value.transports === undefined || transports && new Set(transports).size === transports.length && transports.every(knownTransport));
}
function validPolicy(originValue, rpValue) {
  const origins = values(originValue); const rpIDs = values(rpValue); if (!origins || !rpIDs || rpIDs.length !== 1) return undefined;
  const rpID = rpIDs[0]; if (!validRpID(rpID) || !origins.every((origin) => validOrigin(origin, rpID))) return undefined;
  return { origins, rpID };
}
function values(value) { const result = typeof value === "string" ? [value] : projectStringArray(value, 16); return result && result.length >= 1 && new Set(result).size === result.length ? result : undefined; }
function validRpID(value) { return value.length <= 253 && value === value.toLowerCase() && !value.endsWith(".") && !value.includes("..") && (value === "localhost" || value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))); }
function validOrigin(value, rpID) { if (value.length > 2_048) return false; try { const origin = new URL(value); return origin.origin === value && !origin.username && !origin.password && (origin.protocol === "https:" || origin.protocol === "http:" && origin.hostname === "localhost") && (origin.hostname === rpID || origin.hostname.endsWith(`.${rpID}`)); } catch { return false; } }
function safeEnvelope(value) { try { return Buffer.byteLength(canonicalJson(value), "utf8") <= 131_072; } catch { return false; } }
function canonicalBase64url(value, minimum, maximum) { if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) return false; const decoded = Buffer.from(value, "base64url"); return decoded.length >= minimum && decoded.length <= maximum && decoded.toString("base64url") === value; }
function safeId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function uint32(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff; }
function knownTransport(value) { return typeof value === "string" && ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"].includes(value); }

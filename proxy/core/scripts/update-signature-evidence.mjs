import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";

const schema = "uptokey-update-signature-evidence-v1";

export function updateKeyFingerprint(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("update_public_key_must_be_p256");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

export function createUpdateSignatureReceipt(subjectPath, signaturePath, publicKeyPath) {
  const subject = readFileSync(realpathSync(subjectPath));
  const signatureText = readFileSync(realpathSync(signaturePath), "utf8").trim();
  const publicKey = readFileSync(realpathSync(publicKeyPath));
  const verified = verifyUpdateSignatureContent(subject, signatureText, publicKey);
  return {
    schema, algorithm: "ES256", subjectSha256: verified.subjectSha256, verifiedAt: new Date().toISOString(),
    signer: { keyFingerprint: verified.keyFingerprint }, checks: { signature: true, p256: true, detached: true },
  };
}

export function verifyUpdateSignatureContent(subject, signatureText, publicKey) {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signatureText)) throw new Error("update_signature_encoding_invalid");
  const signature = Buffer.from(signatureText, "base64url");
  if (signature.length !== 64) throw new Error("update_signature_length_invalid");
  const fingerprint = updateKeyFingerprint(publicKey);
  if (!verify("sha256", subject, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)) throw new Error("update_signature_invalid");
  return { subjectSha256: createHash("sha256").update(subject).digest("hex"), keyFingerprint: fingerprint };
}

export function validateUpdateSignatureReceipt(receipt, subjectSha256, signerId) {
  const errors = [];
  if (!updateReceiptShape(receipt)) errors.push("update_receipt_schema_invalid");
  if (receipt?.algorithm !== "ES256") errors.push("update_receipt_algorithm_invalid");
  if (receipt?.subjectSha256 !== subjectSha256) errors.push("update_receipt_subject_mismatch");
  if (!/^[a-f0-9]{64}$/.test(receipt?.signer?.keyFingerprint ?? "")) errors.push("update_receipt_fingerprint_invalid");
  if (receipt?.signer?.keyFingerprint !== signerId) errors.push("update_receipt_signer_mismatch");
  if (receipt?.checks?.signature !== true || receipt?.checks?.p256 !== true || receipt?.checks?.detached !== true) errors.push("update_receipt_check_failed");
  return errors;
}

function updateReceiptShape(receipt) {
  return isRecord(receipt) && exactKeys(receipt, ["schema", "algorithm", "subjectSha256", "verifiedAt", "signer", "checks"])
    && receipt.schema === schema && receipt.algorithm === "ES256" && /^[a-f0-9]{64}$/.test(receipt.subjectSha256 ?? "")
    && typeof receipt.verifiedAt === "string" && Number.isFinite(Date.parse(receipt.verifiedAt))
    && isRecord(receipt.signer) && exactKeys(receipt.signer, ["keyFingerprint"])
    && isRecord(receipt.checks) && exactKeys(receipt.checks, ["signature", "p256", "detached"]);
}
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }

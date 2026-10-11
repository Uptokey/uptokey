import type { KeyObject } from "node:crypto";
export interface UpdateSignatureReceipt { schema: string; algorithm: "ES256"; subjectSha256: string; verifiedAt: string; signer: { keyFingerprint: string }; checks: { signature: true; p256: true; detached: true } }
export function updateKeyFingerprint(publicKey: string | Buffer | KeyObject): string;
export function createUpdateSignatureReceipt(subjectPath: string, signaturePath: string, publicKeyPath: string): UpdateSignatureReceipt;
export function verifyUpdateSignatureContent(subject: string | Buffer, signatureText: string, publicKey: string | Buffer | KeyObject): { subjectSha256: string; keyFingerprint: string };
export function validateUpdateSignatureReceipt(receipt: unknown, subjectSha256: string, signerId: string | undefined): string[];

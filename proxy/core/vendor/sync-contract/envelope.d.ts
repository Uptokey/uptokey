export const SYNC_ALGORITHM: "HPKE-P256-HKDF-SHA256-AES-256-GCM";
export const SYNC_SCHEMA_VERSION: 2;
export interface SyncEnvelopeContract {
  device_id: string;
  config_version: number;
  schema_version: 2;
  algorithm: typeof SYNC_ALGORITHM;
  ephemeral_public_key: string;
  nonce: string;
  ciphertext: string;
  created_at: string;
}
export function isSyncEnvelope(value: unknown): value is SyncEnvelopeContract;
export function isP256PublicKey(value: unknown): value is string;

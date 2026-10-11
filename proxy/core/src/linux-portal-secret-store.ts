import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { assertQuimeraDataPath, dataDir, QUIMERA_SECRET_SERVICE } from "./paths.ts";
import type { SecretStore, SecretStoreBoundary } from "./secret-store.ts";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { asDataRecord as record } from "@uptokey/sync-contract/plain-data";

interface SealedValue { nonce: string; ciphertext: string; tag: string }
interface SealedFile { schema: "uptokey-linux-portal-secrets-v1"; values: Record<string, SealedValue> }

export class LinuxPortalSecretStore implements SecretStore {
  private queue = Promise.resolve();
  private readonly masterSecret: () => Promise<Uint8Array>;
  private readonly path: string;
  constructor(masterSecret: () => Promise<Uint8Array>, path = `${dataDir()}/secrets.portal.json`) { this.masterSecret = masterSecret; this.path = assertQuimeraDataPath(path); }

  securityBoundary(): SecretStoreBoundary { return { mechanism: "linux-secret-portal", native: true, applicationBound: true }; }

  async get(account: string): Promise<string | undefined> {
    validateAccount(account);
    try { return await this.exclusive(async () => {
      const document = await this.load(); const sealed = document.values[account];
      if (!sealed) return undefined;
      const key = await this.key();
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64url"), { authTagLength: 16 });
        decipher.setAAD(Buffer.from(account)); decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64url")), decipher.final()]).toString("utf8");
      } finally { key.fill(0); }
    }); } catch (error) { throw safeOperationError(error, "secret_store_read_unavailable"); }
  }

  async set(account: string, value: string): Promise<void> {
    validateAccount(account); if (!value || Buffer.byteLength(value) > 16_384) throw new Error("secret_size_invalid");
    try { await this.exclusive(async () => {
      const document = await this.load(); const key = await this.key(); const nonce = randomBytes(12);
      try {
        const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(Buffer.from(account));
        const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        document.values[account] = { nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
        await this.save(document);
      } finally { key.fill(0); nonce.fill(0); }
    }); } catch (error) { throw safeOperationError(error, "secret_store_write_unavailable"); }
  }

  async delete(account: string): Promise<void> {
    validateAccount(account);
    try { await this.exclusive(async () => { const document = await this.load(); if (delete document.values[account]) await this.save(document); }); }
    catch (error) { throw safeOperationError(error, "secret_store_delete_unavailable"); }
  }

  private async key(): Promise<Buffer> {
    const master = await this.masterSecret();
    if (!(master instanceof Uint8Array) || master.byteLength < 16 || master.byteLength > 4096) throw new Error("linux_portal_master_secret_invalid");
    const mutable = Buffer.from(master);
    try { return Buffer.from(hkdfSync("sha256", mutable, QUIMERA_SECRET_SERVICE, "uptokey-linux-portal-store-v1", 32)); }
    finally { mutable.fill(0); master.fill(0); }
  }

  private async load(): Promise<SealedFile> {
    assertQuimeraDataPath(this.path);
    const parsed = await readJson<unknown>(this.path, { schema: "uptokey-linux-portal-secrets-v1", values: {} }, 512 * 1024);
    assertSealedFile(parsed); return parsed;
  }

  private async save(document: SealedFile): Promise<void> {
    assertQuimeraDataPath(this.path);
    assertSealedFile(document); await writeJsonAtomic(this.path, document, { maximum: 512 * 1024 });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation); this.queue = result.then(() => undefined, () => undefined); return result;
  }
}

function validateAccount(account: string): void {
  if (!/^[A-Za-z0-9:_.-]{1,128}$/.test(account)) throw new Error("account_invalid");
}

function assertSealedFile(value: unknown): asserts value is SealedFile {
  const root = record(value); if (!root || Object.keys(root).sort().join(",") !== "schema,values" || root.schema !== "uptokey-linux-portal-secrets-v1") invalidFile();
  const values = record(root.values); if (!values || Object.keys(values).length > 256) invalidFile();
  for (const [account, raw] of Object.entries(values)) {
    validateAccount(account); const item = record(raw);
    if (!item || Object.keys(item).sort().join(",") !== "ciphertext,nonce,tag" || !encoded(item.nonce, 12, 12) || !encoded(item.tag, 16, 16) || !encoded(item.ciphertext, 1, 16_384)) invalidFile();
  }
}
function encoded(value: unknown, minimum: number, maximum: number): boolean { if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false; try { const bytes = Buffer.from(value, "base64url"); return bytes.byteLength >= minimum && bytes.byteLength <= maximum && bytes.toString("base64url") === value; } catch { return false; } }
function invalidFile(): never { throw new Error("linux_portal_secret_file_invalid"); }
function safeOperationError(error: unknown, fallback: string): Error {
  return error instanceof Error && ["linux_portal_secret_file_invalid", "linux_portal_master_secret_invalid"].includes(error.message) ? new Error(error.message) : new Error(fallback);
}

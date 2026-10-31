import { open, mkdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local';
import { VaultCrypto } from './vendor/vault-crypto.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_OBJECT_ID = 'harness-credentials';
const DEFAULT_SCOPE = 'credentials';

async function readPrivate(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077)) throw Error('vault_file_permissions_or_size');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

function validate(document) {
  try {
    const text = JSON.stringify(document);
    if (Buffer.byteLength(text) > MAX_BYTES) throw Error('limit');
    const parsed = parseCredentialsDocument(text, 'encrypted-vault');
    if (parsed.ignoredKeys.length) throw Error('unknown');
    return { version: 1, refs: Object.fromEntries(parsed.refs), records: Object.fromEntries(parsed.records) };
  } catch { throw Error('vault_document_invalid'); }
}

export class EncryptedStore {
  constructor({ path, keyPath, objectId = DEFAULT_OBJECT_ID, resourceScope = DEFAULT_SCOPE }) {
    this.path = path;
    this.keyPath = keyPath;
    this.objectId = objectId;
    this.resourceScope = resourceScope;
    this.closed = false;
    this.pending = new Set();
    const secretStore = {
      get: async account => {
        if (account !== 'vault:key') throw Error('vault_key_account_invalid');
        let key;
        try { key = await readPrivate(this.keyPath, 64); }
        catch { throw Error('vault_key_unavailable'); }
        if (!/^[a-f0-9]{64}$/.test(key)) throw Error('vault_key_invalid');
        return key;
      },
      set: async () => { throw Error('vault_key_readonly'); },
      delete: async () => { throw Error('vault_key_readonly'); },
    };
    this.crypto = new VaultCrypto(secretStore, { vaultId: 'deepseek-workbench', tenantScope: 'local', maxPayloadBytes: MAX_BYTES });
  }
  async ready() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if ((await lstat(dirname(this.path))).isSymbolicLink()) throw Error('vault_directory_link');
    await this.crypto.ensureVaultKey();
    await this.read();
  }
  async read() {
    if (this.closed) throw Error('vault_closed');
    let text;
    try { text = await readPrivate(this.path, MAX_BYTES * 2); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, refs: {}, records: {} };
      throw Error('vault_read_failed');
    }
    let plain;
    try {
      plain = await this.crypto.decryptObject(JSON.parse(text), { objectId: this.objectId, resourceScope: this.resourceScope });
      return validate(JSON.parse(Buffer.from(plain).toString('utf8')));
    } catch { throw Error('vault_authentication_failed'); }
    finally { plain?.fill(0); }
  }
  async mutate(operation) {
    if (this.closed) throw Error('vault_closed');
    const pending = withFileLock(this.path, async () => {
      const document = await this.read();
      const result = await operation(document);
      if (this.closed) throw Error('vault_closed');
      const checked = validate(document);
      const plain = Buffer.from(JSON.stringify(checked));
      try {
        const envelope = await this.crypto.encryptObject(this.objectId, plain, { resourceScope: this.resourceScope });
        await writeFileAtomic(this.path, JSON.stringify(envelope), { mode: 0o600, dirMode: 0o700 });
      } finally { plain.fill(0); }
      return result;
    }, { waitMs: 30_000 });
    this.pending.add(pending);
    try { return await pending; } finally { this.pending.delete(pending); }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}

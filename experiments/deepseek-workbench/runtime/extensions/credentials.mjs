import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { Service } from '@deepseek-ai/cordis';
import { CredentialProvider, credentialRef, parseCredentialKey } from '@deepseek-ai/dsh-credentials';
import { EncryptedStore } from './encrypted-store.mjs';

const BROWSER_SESSION_RECORD = 'client-connection/browser-session';

function browserSessionRecord(record) {
  if (record === undefined) return undefined;
  if (!record || record.kind !== 'grant' || !record.payload || record.payload.version !== 1 ||
      typeof record.payload.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.payload.secret) ||
      Object.keys(record).length !== 2 || Object.keys(record.payload).length !== 2) {
    throw Error('browser_session_record_invalid');
  }
  return record;
}

// Implements the existing service without becoming a second credential vault.
// Provider/BYOK credentials belong to the Uptokey core and OS keyring.  The
// controller receives only two read-only transport capabilities.
export default class UptokeyCredentials extends CredentialProvider {
  static Config = z.object({ path: z.string().required(), keyPath: z.string().required(), bridgeKeyPath: z.string(), localModelKeyPath: z.string() });
  constructor(ctx, config) {
    super(ctx);
    // This store signs only the local Harness browser cookie.  It is bound to
    // a distinct file, object id and AAD scope, so the historical provider
    // credential document is never opened or accepted here.
    this.browserSessionStore = new EncryptedStore({
      path: join(dirname(config.path), 'browser-session.encrypted.json'),
      keyPath: config.keyPath,
      objectId: 'harness-browser-session',
      resourceScope: 'browser-session-auth',
    });
    this.bridgeKeyPath = config.bridgeKeyPath;
    this.localModelKeyPath = config.localModelKeyPath;
  }
  async* [Service.init]() {
    yield () => this.browserSessionStore.close();
    await this.browserSessionStore.ready();
  }
  async resolve(ref) {
    credentialRef(ref);
    // The canonical Uptokey provider contract treats loopback Ollama as
    // keyless. llm-pi-ai still requires a non-empty request credential for a
    // hand-declared OpenAI-compatible route, so project that existing rule
    // through the credential seam only while the authenticated reverse-SSH
    // transport is mounted. This marker is not a user/provider secret.
    if (ref === 'OLLAMA_LOCAL_API_KEY' && this.localModelKeyPath) {
      const authorization = (await readFile(this.localModelKeyPath, 'utf8')).trim();
      if (!/^restrict,port-forwarding,permitlisten="127\.0\.0\.1:43192" ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(authorization)) throw Error('local_model_transport_invalid');
      return { value: 'uptokey-local-keyless', source: 'local-transport' };
    }
    if (ref === 'UPTOKEY_LOCAL_API_KEY' && this.bridgeKeyPath) {
      const value = (await readFile(this.bridgeKeyPath, 'utf8')).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw Error('core_bridge_gate_invalid');
      return { value, source: 'file' };
    }
    return undefined;
  }
  async describe(ref) {
    if (ref === 'OLLAMA_LOCAL_API_KEY' && this.localModelKeyPath) {
      try { await this.resolve(ref);return { configured: true, writable: false, source: 'local-transport' }; }
      catch { return { configured: false, writable: false }; }
    }
    if (ref === 'UPTOKEY_LOCAL_API_KEY' && this.bridgeKeyPath) {
      try { await access(this.bridgeKeyPath);return { configured: true, writable: false, source: 'file' }; }
      catch { return { configured: false, writable: false }; }
    }
    credentialRef(ref);
    return { configured: false, writable: false };
  }
  async set(ref, value) {
    credentialRef(ref);
    if (ref === 'OLLAMA_LOCAL_API_KEY' && this.localModelKeyPath) throw Error('local_model_credential_readonly');
    if (ref === 'UPTOKEY_LOCAL_API_KEY' && this.bridgeKeyPath) throw Error('core_bridge_credential_readonly');
    void value;
    throw Error('credential_owner_is_uptokey_core');
  }
  async unset(ref) {
    credentialRef(ref);
    if (ref === 'OLLAMA_LOCAL_API_KEY' && this.localModelKeyPath) throw Error('local_model_credential_readonly');
    if (ref === 'UPTOKEY_LOCAL_API_KEY' && this.bridgeKeyPath) throw Error('core_bridge_credential_readonly');
    throw Error('credential_owner_is_uptokey_core');
  }
  async readRecord(key) {
    parseCredentialKey(key);
    if (key !== BROWSER_SESSION_RECORD) return undefined;
    return browserSessionRecord((await this.browserSessionStore.read()).records[key]);
  }
  async describeRecord(key) {
    const record = await this.readRecord(key);
    if (key !== BROWSER_SESSION_RECORD) return { configured: false, writable: false };
    return { configured: record !== undefined, writable: true, ...(record ? { kind: record.kind } : {}) };
  }
  async listRecords() {
    const record = await this.readRecord(BROWSER_SESSION_RECORD);
    return record ? [{ key: BROWSER_SESSION_RECORD, kind: record.kind }] : [];
  }
  async modifyRecord(key, mutate) {
    parseCredentialKey(key);
    if (key !== BROWSER_SESSION_RECORD) throw Error('credential_owner_is_uptokey_core');
    const result = await this.browserSessionStore.mutate(async document => {
      const current = browserSessionRecord(document.records[key]);
      const next = await mutate(current);
      if (next !== undefined) document.records[key] = browserSessionRecord(next);
      return browserSessionRecord(document.records[key]);
    });
    this.notifyRecordUpdated(key);
    return result;
  }
  async deleteRecord(key) {
    parseCredentialKey(key);
    if (key !== BROWSER_SESSION_RECORD) throw Error('credential_owner_is_uptokey_core');
    await this.browserSessionStore.mutate(document => { delete document.records[key]; });
    this.notifyRecordUpdated(key);
  }
}

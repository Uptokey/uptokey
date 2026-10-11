import type { SecretStore } from "./secret-store.ts";
import type { ControlIdentity } from "./control-capability.ts";
import { loadControlIdentity, saveControlIdentity } from "./control-identity.ts";
import { readJson } from "./atomic-json.ts";
import { syncStatePath } from "./paths.ts";

export const WEBAUTHN_COUNTER_ACCOUNT = "device:webauthn-counter";

export class WebAuthnCounterCoordinator {
  private serial: Promise<void> = Promise.resolve();
  private readonly secrets: SecretStore;
  constructor(secrets: SecretStore) { this.secrets = secrets; }

  async run<T>(identity: ControlIdentity, operation: (currentCounter: number) => Promise<{ result: T; nextCounter: number }>): Promise<T> {
    let result!: T;
    const task = this.serial.then(async () => {
      const current = await this.current(identity);
      const completed = await operation(current);
      if (!safeCounter(completed.nextCounter) || completed.nextCounter < current || current > 0 && completed.nextCounter === current) throw new Error("webauthn_counter_regression");
      const anchor = JSON.stringify({ credentialId: identity.credential.id, counter: completed.nextCounter });
      await this.secrets.set(WEBAUTHN_COUNTER_ACCOUNT, anchor);
      const persisted = await loadControlIdentity();
      if (persisted && sameCredential(persisted, identity)) await saveControlIdentity({ ...persisted, credential: { ...persisted.credential, counter: completed.nextCounter } });
      identity.credential.counter = completed.nextCounter;
      result = completed.result;
    });
    this.serial = task.catch(() => undefined); await task; return result;
  }

  async clear(): Promise<void> { await this.secrets.delete(WEBAUTHN_COUNTER_ACCOUNT); }

  private async current(identity: ControlIdentity): Promise<number> {
    const counters = [identity.credential.counter];
    const persisted = await loadControlIdentity(); if (persisted && sameCredential(persisted, identity)) counters.push(persisted.credential.counter);
    const anchor = await this.secrets.get(WEBAUTHN_COUNTER_ACCOUNT);
    if (anchor) { try { const value = JSON.parse(anchor) as { credentialId?: unknown; counter?: unknown }; if (value.credentialId === identity.credential.id && safeCounter(value.counter)) counters.push(value.counter); else if (value.credentialId === identity.credential.id) throw new Error(); } catch { throw new Error("webauthn_counter_anchor_invalid"); } }
    const state = await readJson<Record<string, unknown> | null>(syncStatePath(), null);
    if (state?.webauthnCounter !== undefined) { if (!safeCounter(state.webauthnCounter)) throw new Error("webauthn_counter_anchor_invalid"); counters.push(state.webauthnCounter); }
    return Math.max(...counters);
  }
}

function sameCredential(left: ControlIdentity, right: ControlIdentity): boolean { return left.tenantId === right.tenantId && left.deviceId === right.deviceId && left.credential.id === right.credential.id; }
function safeCounter(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff; }

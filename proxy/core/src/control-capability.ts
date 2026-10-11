import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { envelopeChallenge, verifyEnvelopeAssertion } from "@uptokey/sync-contract/server";
import type { EnvelopeCredential } from "@uptokey/sync-contract/server";
import type { WebAuthnCounterCoordinator } from "./webauthn-counter.ts";
import { normalizeClientName } from "./client-name.ts";
import { assertControlIdentity } from "./control-identity.ts";

export const CONTROL_PAIR_TTL_MS = 5 * 60_000;
export const CONTROL_CAPABILITY_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;

interface PendingPair {
  origin: string;
  clientName: string;
  userCode: string;
  deadline: number;
  approved: boolean;
  intent: Record<string, unknown>;
  identity: ControlIdentity;
  bootstrapToken: string;
}

interface Capability {
  origin: string;
  tenantId: string;
  deviceId: string;
  method: string;
  path: string;
  deadline: number;
}

export interface ControlIdentity {
  tenantId: string;
  deviceId: string;
  credential: EnvelopeCredential;
  expectedOrigin: string;
  expectedRPID: string;
}

type AssertionVerifier = typeof verifyEnvelopeAssertion;

export class ControlCapabilityService {
  private readonly pending = new Map<string, PendingPair>();
  private readonly capabilities = new Map<string, Capability>();
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private identity?: ControlIdentity;
  private readonly assertionVerifier: AssertionVerifier;
  private readonly persistCounter?: (counter: number) => Promise<void>;
  private readonly persistIdentity?: (identity: ControlIdentity) => Promise<void>;
  private readonly deleteIdentity?: () => Promise<void>;
  private readonly provisionDeviceAuth?: (identity: ControlIdentity, bootstrapToken: string) => Promise<void>;
  private readonly counterCoordinator?: WebAuthnCounterCoordinator;
  private serial: Promise<void> = Promise.resolve();
  private lifecycleSerial: Promise<void> = Promise.resolve();
  constructor(options: { identity?: ControlIdentity; assertionVerifier?: AssertionVerifier; persistCounter?: (counter: number) => Promise<void>; persistIdentity?: (identity: ControlIdentity) => Promise<void>; deleteIdentity?: () => Promise<void>; provisionDeviceAuth?: (identity: ControlIdentity, bootstrapToken: string) => Promise<void>; counterCoordinator?: WebAuthnCounterCoordinator; now?: () => number; wallNow?: () => number } = {}) {
    this.identity = options.identity === undefined ? undefined : validatedIdentity(options.identity); this.assertionVerifier = options.assertionVerifier ?? verifyEnvelopeAssertion; this.persistCounter = options.persistCounter; this.persistIdentity = options.persistIdentity; this.deleteIdentity = options.deleteIdentity; this.provisionDeviceAuth = options.provisionDeviceAuth; this.counterCoordinator = options.counterCoordinator; this.now = options.now ?? performance.now.bind(performance); this.wallNow = options.wallNow ?? Date.now;
  }

  create(origin: string, clientName: string, tenantId: string, deviceId: string, bootstrapCredential?: EnvelopeCredential, bootstrapRPID?: string, bootstrapToken?: string): { id: string; userCode: string; expiresAt: string; request: { tenantId: string; credentialId: string; challenge: string } } {
    this.prune();
    if (!bootstrapToken || !/^utk_bootstrap_[A-Za-z0-9_-]{40,}$/.test(bootstrapToken)) throw new Error("control_bootstrap_token_rejected");
    const normalizedClientName = normalizeClientName(clientName);
    if (!safeControlOrigin(origin) || !safeId(tenantId) || !safeId(deviceId) || !normalizedClientName) throw new Error("control_pairing_request_rejected");
    if (!this.pairingConfigured()) throw new Error("control_pairing_not_configured");
    const identity = this.identity ?? bootstrapIdentity(origin, tenantId, deviceId, bootstrapCredential, bootstrapRPID);
    if (tenantId !== identity.tenantId || deviceId !== identity.deviceId || origin !== identity.expectedOrigin) throw new Error("control_identity_rejected");
    if (this.pending.size >= MAX_PENDING) throw new Error("control_pairing_capacity_exceeded");
    const id = randomUUID();
    const userCode = randomBytes(3).toString("hex").toUpperCase();
    const expiry = this.expiry(CONTROL_PAIR_TTL_MS);
    const intent = { purpose: "dashboard_control_pair", pairing_id: id, device_id: deviceId, origin, expires_at: expiry.iso };
    this.pending.set(id, { origin, clientName: normalizedClientName, userCode, deadline: expiry.deadline, approved: false, intent, identity, bootstrapToken });
    return { id, userCode, expiresAt: expiry.iso, request: { tenantId, credentialId: identity.credential.id, challenge: envelopeChallenge(tenantId, intent) } };
  }

  approve(id: string, userCode: string): boolean {
    this.prune();
    if (!isUuidV4(id) || !/^[0-9A-Fa-f]{6}$/.test(userCode)) return false;
    const item = this.pending.get(id);
    if (!item || !safeEqual(item.userCode, userCode.toUpperCase())) return false;
    item.approved = true;
    return true;
  }

  isApprovedPending(id: string, origin: string): boolean {
    this.prune();
    if (!isUuidV4(id) || !safeControlOrigin(origin)) return false;
    const item = this.pending.get(id);
    return !!item && item.approved && item.origin === origin;
  }

  async consume(id: string, origin: string, assertion: unknown): Promise<{ capability: string; expiresAt: string } | undefined> {
    if (!isUuidV4(id) || !safeControlOrigin(origin) || assertion === null || assertion === undefined) return undefined;
    let result: { capability: string; expiresAt: string } | undefined;
    const operation = this.lifecycleSerial.then(async () => { result = await this.consumeOnce(id, origin, assertion); });
    this.lifecycleSerial = operation.catch(() => undefined); await operation;
    return result;
  }

  private async consumeOnce(id: string, origin: string, assertion: unknown): Promise<{ capability: string; expiresAt: string } | undefined> {
    this.prune();
    const item = this.pending.get(id);
    const identity = item?.identity;
    if (!item || !item.approved || item.origin !== origin || !identity) return undefined;
    const capability = `utk_control_${randomBytes(32).toString("base64url")}`;
    const expiry = this.expiry(CONTROL_CAPABILITY_TTL_MS);
    let newCounter: number;
    try {
      newCounter = this.identity && this.counterCoordinator
        ? await this.counterCoordinator.run(identity, async (currentCounter) => { const nextCounter = await this.assertionVerifier({ assertion, credential: cloneCredential(identity.credential, currentCounter), tenantId: identity.tenantId, envelope: structuredClone(item.intent), expectedOrigin: identity.expectedOrigin, expectedRPID: identity.expectedRPID }); return { result: nextCounter, nextCounter }; })
        : await this.assertionVerifier({ assertion, credential: cloneCredential(identity.credential), tenantId: identity.tenantId, envelope: structuredClone(item.intent), expectedOrigin: identity.expectedOrigin, expectedRPID: identity.expectedRPID });
    }
    catch { return undefined; }
    if (!safeCounter(newCounter) || newCounter < identity.credential.counter || identity.credential.counter > 0 && newCounter === identity.credential.counter) return undefined;
    const verifiedAt = this.now();
    if (!deadlineActive(item.deadline, verifiedAt) || !deadlineActive(expiry.deadline, verifiedAt)) return undefined;
    this.pending.delete(id);
    if (!this.provisionDeviceAuth) return undefined;
    if (!this.identity) {
      const provisioned = { ...identity, credential: { ...identity.credential, counter: newCounter } };
      if (!this.persistIdentity || !this.deleteIdentity) return undefined;
      try {
        await this.persistIdentity(validatedIdentity(provisioned));
        await this.provisionDeviceAuth(validatedIdentity(provisioned), item.bootstrapToken);
      }
      catch (provisionError) {
        try { await this.deleteIdentity(); }
        catch (rollbackError) { throw new AggregateError([provisionError, rollbackError], "control_first_pair_rollback_failed"); }
        throw provisionError;
      }
      this.identity = provisioned;
    } else {
      if (!this.counterCoordinator) await this.updateCounter(identity.credential.counter, newCounter);
      await this.provisionDeviceAuth(validatedIdentity(identity), item.bootstrapToken);
    }
    if (!deadlineActive(expiry.deadline, this.now())) return undefined;
    this.capabilities.set(hash(capability), { origin, tenantId: identity.tenantId, deviceId: identity.deviceId, method: "GET", path: "/control/status", deadline: expiry.deadline });
    return { capability, expiresAt: expiry.iso };
  }

  private async updateCounter(expected: number, nextCounter: number): Promise<void> {
    const operation = this.serial.then(async () => {
      if (!this.identity || this.identity.credential.counter !== expected) throw new Error("webauthn_counter_race");
      if (!safeCounter(nextCounter) || nextCounter < expected || expected > 0 && nextCounter === expected) throw new Error("webauthn_counter_regression");
      if (this.persistCounter) await this.persistCounter(nextCounter);
      else if (this.persistIdentity) await this.persistIdentity(validatedIdentity({ ...this.identity, credential: { ...this.identity.credential, counter: nextCounter } }));
      this.identity.credential.counter = nextCounter;
    });
    this.serial = operation.catch(() => undefined); await operation;
  }

  authorize(capability: string | undefined, origin: string, method: string, path: string): boolean {
    return this.authorizeContext(capability, origin, method, path) !== undefined;
  }

  authorizeContext(capability: string | undefined, origin: string, method: string, path: string): { tenantId: string; deviceId: string } | undefined {
    this.prune();
    if (!capability || !/^utk_control_[A-Za-z0-9_-]{43}$/.test(capability) || !safeControlOrigin(origin)) return undefined;
    const item = this.capabilities.get(hash(capability));
    return item && item.origin === origin && item.method === method.toUpperCase() && item.path === path && item.deadline > this.now()
      ? { tenantId: item.tenantId, deviceId: item.deviceId } : undefined;
  }

  currentIdentityContext(): { tenantId: string; deviceId: string } | undefined {
    return this.identity ? { tenantId: this.identity.tenantId, deviceId: this.identity.deviceId } : undefined;
  }

  pairingConfigured(): boolean { return !!this.provisionDeviceAuth && (!!this.identity || !!this.persistIdentity && !!this.deleteIdentity); }

  async revokeAll(): Promise<void> {
    const operation = this.lifecycleSerial.then(async () => {
      this.pending.clear(); this.capabilities.clear(); this.identity = undefined;
      if (this.deleteIdentity) await this.deleteIdentity();
    });
    this.lifecycleSerial = operation.catch(() => undefined); await operation;
  }

  private prune(): void {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) { this.pending.clear(); this.capabilities.clear(); return; }
    for (const [id, item] of this.pending) if (item.deadline <= now) this.pending.delete(id);
    for (const [tokenHash, item] of this.capabilities) if (item.deadline <= now) this.capabilities.delete(tokenHash);
  }

  private expiry(ttl: number): { deadline: number; iso: string } {
    const observed = this.now(); const wall = this.wallNow();
    if (!Number.isFinite(observed) || observed < 0 || !Number.isFinite(observed + ttl) || !Number.isSafeInteger(wall) || wall < 0 || wall + ttl > 8_640_000_000_000_000) throw new Error("control_clock_invalid");
    return { deadline: observed + ttl, iso: new Date(wall + ttl).toISOString() };
  }
}

function bootstrapIdentity(origin: string, tenantId: string, deviceId: string, credential: EnvelopeCredential | undefined, rpID: string | undefined): ControlIdentity {
  if (!credential || typeof rpID !== "string") throw new Error("control_identity_rejected");
  return validatedIdentity({ tenantId, deviceId, credential: { ...credential }, expectedOrigin: origin, expectedRPID: rpID });
}

function validatedIdentity(value: unknown): ControlIdentity {
  try { assertControlIdentity(value); } catch { throw new Error("control_identity_rejected"); }
  return { ...value, credential: cloneCredential(value.credential) };
}

function cloneCredential(value: EnvelopeCredential, counter = value.counter): EnvelopeCredential { return value.transports === undefined ? { ...value, counter } : { ...value, counter, transports: [...value.transports] }; }

function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function safeCounter(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff; }
function deadlineActive(deadline: number, now: number): boolean { return Number.isFinite(now) && now >= 0 && deadline > now; }
function isUuidV4(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function safeControlOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash && parsed.origin === value;
  } catch { return false; }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  if (left.length !== right.length) { timingSafeEqual(left, left); return false; }
  return timingSafeEqual(left, right);
}

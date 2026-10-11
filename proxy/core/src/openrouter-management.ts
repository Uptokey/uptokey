import type { SecretStore } from "./secret-store.ts";
import { parseManagementKeyCommand, type ManagementKeyCommand } from "@uptokey/sync-contract/openrouter-management";

export const OPENROUTER_MANAGEMENT_BASE = "https://openrouter.ai/api/v1/keys";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const CONFIG_KEY = "local:openrouter:management";
const OP_KEY = (operationId: string) => `local:or-mgmt-ops:${operationId}`;
const RECEIPT_KEY = (hash: string) => `local:or-mgmt-receipt:${hash}`;

export interface RemoteKeyView {
  hash: string;
  name: string;
  limit: number | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

/** E2-21-B: provider-reported credit totals, mapped verbatim from GET /credits (management key required). */
export interface OpenRouterCreditsView {
  source: "openrouter_credits";
  state: "observed";
  measuredAt: string;
  currency: "USD";
  unit: "credits";
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

export class OpenRouterManagementService {
  private readonly secrets: SecretStore;
  private readonly fetchImpl: typeof fetch;
  constructor(secrets: SecretStore, fetchImpl: typeof fetch = fetch) {
    this.secrets = secrets;
    this.fetchImpl = fetchImpl;
  }

  async hasManagementKey(): Promise<boolean> {
    return (await this.secrets.get(CONFIG_KEY)) !== undefined;
  }

  async configureManagementKey(key: string): Promise<void> {
    if (typeof key !== "string" || key.length < 8 || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error("management_key_invalid");
    await this.secrets.set(CONFIG_KEY, key);
  }

  async clearManagementKey(): Promise<void> {
    await this.secrets.delete(CONFIG_KEY);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const key = await this.secrets.get(CONFIG_KEY);
    if (!key) throw new Error("management_key_required");
    return { authorization: `Bearer ${key}`, "content-type": "application/json" };
  }

  private async readOp(operationId: string): Promise<unknown> {
    const raw = await this.secrets.get(OP_KEY(operationId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private async writeOp(operationId: string, value: unknown): Promise<void> {
    await this.secrets.set(OP_KEY(operationId), JSON.stringify(value));
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = await this.authHeaders();
    return this.fetchImpl(new URL(path, OPENROUTER_MANAGEMENT_BASE + "/").toString().replace(/\/$/, "") === OPENROUTER_MANAGEMENT_BASE
      ? OPENROUTER_MANAGEMENT_BASE
      : `${OPENROUTER_MANAGEMENT_BASE}${path}`, {
      ...init,
      redirect: "error",
      headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) },
    });
  }

  private projectKeyView(raw: unknown): RemoteKeyView {
    if (!raw || typeof raw !== "object") throw new Error("upstream_protocol_invalid");
    const record = raw as Record<string, unknown>;
    const data = (record.data && typeof record.data === "object" ? record.data : record) as Record<string, unknown>;
    const hash = typeof data.hash === "string" ? data.hash : typeof data.id === "string" ? data.id : undefined;
    if (!hash || hash.length < 8 || hash.length > 128) throw new Error("upstream_protocol_invalid");
    // Never accept a raw key value as identifier; hash is opaque.
    if (typeof (data as Record<string, unknown>).key === "string" && (data as Record<string, unknown>).key === hash) throw new Error("upstream_protocol_invalid");
    return {
      hash,
      name: typeof data.name === "string" ? data.name : typeof data.label === "string" ? data.label : "openrouter-key",
      limit: typeof data.limit === "number" ? data.limit : null,
      disabled: data.disabled === true || data.enabled === false,
      createdAt: typeof data.created_at === "string" ? data.created_at : typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
      updatedAt: typeof data.updated_at === "string" ? data.updated_at : new Date().toISOString(),
      expiresAt: typeof data.expires_at === "string" ? data.expires_at : null,
    };
  }

  async execute(command: ManagementKeyCommand): Promise<{ view?: RemoteKeyView; views?: RemoteKeyView[]; keyValueOnce?: string }> {
    parseManagementKeyCommand(command);
    const seen = await this.readOp(command.operationId);
    if (seen !== undefined) return seen as { view?: RemoteKeyView; views?: RemoteKeyView[]; keyValueOnce?: string };

    if (command.kind === "create") {
      const body: Record<string, unknown> = { name: command.name };
      if (command.expiresAt !== undefined) body.expires_at = command.expiresAt;
      if (command.limit !== undefined) body.limit = command.limit;
      if (command.limitReset !== undefined && command.limitReset !== null) body.limit_reset = command.limitReset;
      if (command.includeByokInLimit !== undefined) body.include_byok_in_limit = command.includeByokInLimit;
      let response: Response;
      try {
        response = await this.request("", { method: "POST", body: JSON.stringify(body) });
      } catch {
        // Loss of creation response: reconcile via list before any retry; never auto-recreate.
        const reconciled = await this.reconcileByName(command.name);
        if (reconciled) {
          const result = { view: reconciled };
          await this.writeOp(command.operationId, result);
          await this.secrets.set(RECEIPT_KEY(reconciled.hash), JSON.stringify({ operationId: command.operationId, at: new Date().toISOString() }));
          return result;
        }
        throw new Error("upstream_unreachable");
      }
      if (response.status === 429) throw new Error("key_limit_exceeded");
      if (!response.ok) throw new Error("upstream_protocol_invalid");
      const payload = await response.json() as Record<string, unknown>;
      const view = this.projectKeyView(payload);
      const data = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
      const keyValue = typeof data.key === "string" ? data.key : undefined;
      // Persist receipt without the secret value.
      await this.secrets.set(RECEIPT_KEY(view.hash), JSON.stringify({ operationId: command.operationId, at: new Date().toISOString() }));
      const result = keyValue ? { view, keyValueOnce: keyValue } : { view };
      await this.writeOp(command.operationId, keyValue ? { view } : result);
      // Never return stored secret on replay: idempotent replay omits keyValueOnce.
      return result;
    }

    if (command.kind === "list") {
      const response = await this.request("", { method: "GET" });
      if (response.status === 429) throw new Error("key_limit_exceeded");
      if (!response.ok) throw new Error("upstream_protocol_invalid");
      const payload = await response.json() as Record<string, unknown>;
      const items = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.keys) ? payload.keys : [];
      const views = items.map((item) => this.projectKeyView(item));
      const result = { views };
      await this.writeOp(command.operationId, result);
      return result;
    }

    const encoded = encodeURIComponent(command.remoteKeyHash);
    if (command.kind === "get") {
      const response = await this.request(`/${encoded}`, { method: "GET" });
      if (response.status === 429) throw new Error("key_limit_exceeded");
      if (response.status === 404) throw new Error("key_not_found");
      if (!response.ok) throw new Error("upstream_protocol_invalid");
      const view = this.projectKeyView(await response.json());
      const result = { view };
      await this.writeOp(command.operationId, result);
      return result;
    }
    if (command.kind === "disable") {
      const response = await this.request(`/${encoded}`, { method: "PATCH", body: JSON.stringify({ disabled: true }) });
      if (response.status === 429) throw new Error("key_limit_exceeded");
      if (response.status === 404) throw new Error("key_not_found");
      if (!response.ok) throw new Error("upstream_protocol_invalid");
      const view = this.projectKeyView(await response.json());
      const result = { view };
      await this.writeOp(command.operationId, result);
      return result;
    }
    if (command.kind === "delete") {
      const response = await this.request(`/${encoded}`, { method: "DELETE" });
      if (response.status === 429) throw new Error("key_limit_exceeded");
      if (response.status === 404) throw new Error("key_not_found");
      if (!response.ok && response.status !== 204) throw new Error("upstream_protocol_invalid");
      await this.secrets.delete(RECEIPT_KEY(command.remoteKeyHash));
      const result = {};
      await this.writeOp(command.operationId, result);
      return result;
    }
    // update (narrowed: create/list/get/disable/delete returned above)
    if (command.kind !== "update") throw new Error("management_key_command_invalid");
    const body: Record<string, unknown> = {};
    if (command.name !== undefined) body.name = command.name;
    if (command.limit !== undefined) body.limit = command.limit;
    if (command.includeByokInLimit !== undefined) body.include_byok_in_limit = command.includeByokInLimit;
    if (command.disabled !== undefined) body.disabled = command.disabled;
    const response = await this.request(`/${encoded}`, { method: "PATCH", body: JSON.stringify(body) });
    if (response.status === 429) throw new Error("key_limit_exceeded");
    if (response.status === 404) throw new Error("key_not_found");
    if (!response.ok) throw new Error("upstream_protocol_invalid");
    const view = this.projectKeyView(await response.json());
    const result = { view };
    await this.writeOp(command.operationId, result);
    return result;
  }

  /** Reconcile after a lost create response: list and match by exact name. */
  async reconcileByName(name: string): Promise<RemoteKeyView | undefined> {
    try {
      const response = await this.request("", { method: "GET" });
      if (!response.ok) return undefined;
      const payload = await response.json() as Record<string, unknown>;
      const items = Array.isArray(payload.data) ? payload.data : [];
      for (const item of items) {
        try {
          const view = this.projectKeyView(item);
          if (view.name === name) return view;
        } catch {
          continue;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /**
   * Reads the account's credit totals with the stored management key (never leaves
   * this device). Maps GET /api/v1/credits verbatim: total_credits/total_usage are
   * provider doubles; remaining is their difference. Unknown/stale stays unknown.
   */
  async readCredits(now = new Date()): Promise<OpenRouterCreditsView> {
    if (!await this.hasManagementKey()) throw new Error("management_key_required");
    const headers = await this.authHeaders();
    delete (headers as Record<string, string>)["content-type"];
    let response: Response;
    try {
      response = await this.fetchImpl(OPENROUTER_CREDITS_URL, { method: "GET", headers, redirect: "error" });
    } catch {
      throw new Error("upstream_unreachable");
    }
    if (response.status === 401) throw new Error("management_key_invalid");
    if (response.status === 403) throw new Error("management_key_forbidden");
    if (response.status === 429) throw new Error("key_limit_exceeded");
    if (!response.ok) throw new Error("upstream_protocol_invalid");
    const payload = await response.json() as Record<string, unknown>;
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data as Record<string, unknown> : undefined;
    const totalCredits = data?.total_credits;
    const totalUsage = data?.total_usage;
    if (typeof totalCredits !== "number" || !Number.isFinite(totalCredits) || totalCredits < 0
      || typeof totalUsage !== "number" || !Number.isFinite(totalUsage) || totalUsage < 0) {
      throw new Error("upstream_protocol_invalid");
    }
    return {
      source: "openrouter_credits",
      state: "observed",
      measuredAt: now.toISOString(),
      currency: "USD",
      unit: "credits",
      totalCredits,
      totalUsage,
      remaining: totalCredits - totalUsage,
    };
  }
}

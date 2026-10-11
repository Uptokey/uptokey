/**
 * Uptokey TUI — HTTP client for the local proxy core.
 * Handles discovery, authentication, health checks, and API calls.
 * This is the ONLY network layer the TUI uses; no direct DB or file access.
 */
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createParser } from "eventsource-parser";
import { createDeadline } from "../deadline.ts";
import { cancelStreamWithin } from "../stream-lifecycle.ts";
import { readBoundedJson } from "@uptokey/sync-contract/limits";
import { isProvider } from "../provider-registry.ts";
import { inferenceFetch } from "../streaming-transport.ts";
import { MAX_INFERENCE_REQUEST_BYTES } from "@uptokey/sync-contract/limits";
import type { MediaDispatchPart } from "./media-input.ts";
import { ACCOUNT_ID, ACCOUNT_MAX_RESPONSE_BYTES, ACCOUNT_MAX_CLIENT_RESPONSE_BYTES, readAccountPublicSession, readAccountPublicUsage, readAccountAvailable, readAccountAdoption, readAccountShareChallenge, readAccountShareRequests, readAccountShareApproval, type AccountPublicSession, type AccountPublicUsage, type AccountAvailable, type AccountAdoption, type AccountShareChallenge, type AccountShareRequest } from "../account-login-protocol.ts";

export type TuiAccountAvailable = AccountAvailable;
export type TuiAccountMutation = AccountAdoption;
export type TuiAccountLogin = { session: AccountPublicSession } | { loginUrl: string; userCode: string; expiresAt: number };
export type TuiAccountChallenge = AccountShareChallenge;
export type TuiAccountRequest = AccountShareRequest;

export type ModelDestination = {
  connectionId: string;
  providerId: string;
  modelId: string;
};

/** Immutable dispatch destination; changing the picker cannot retarget an admitted turn. */
export interface TuiInferenceDestination {
  readonly providerId?: string;
  readonly routingComboId?: string;
  readonly connectionId?: string;
  readonly modelId?: string;
}

/** A declared tool offered to the selected provider; execution remains with its owner. */
export interface TuiFunctionTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface TuiClientOptions {
  baseUrl: string;
  token?: string;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  /** Optional SSE inactivity bound after headers; 0 (default) waits for the model. */
  streamIdleTimeoutMs?: number;
  /** Optional absolute SSE lifetime after headers; 0 (default) disables this bound. */
  streamTotalTimeoutMs?: number;
}

export interface CoreHealth {
  status: "ok" | "error";
  version?: string;
  uptime?: number;
}

export interface ConnectionState {
  phase: "disconnected" | "connecting" | "authenticated" | "expired" | "incompatible" | "error";
  baseUrl: string;
  principal?: string;
  error?: string;
}

export interface StreamEvent {
  type: "text" | "tool_call" | "tool_result" | "error" | "done" | "keepalive";
  data: string;
  id?: string;
}

export class TuiClient extends EventEmitter {
  private baseUrl: string;
  private token: string | undefined;
  private abortController: AbortController;
  private lifetimeSignal: AbortSignal;
  private requestTimeoutMs: number;
  private streamIdleTimeoutMs: number;
  private streamTotalTimeoutMs: number;
  private selectedDestination: TuiInferenceDestination = Object.freeze({});

  constructor(options: TuiClientOptions) {
    super();
    const endpoint = new URL(options.baseUrl);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("tui_loopback_required");
    this.baseUrl = endpoint.origin;
    this.token = options.token;
    this.abortController = new AbortController();
    this.lifetimeSignal = options.signal ? AbortSignal.any([this.abortController.signal, options.signal]) : this.abortController.signal;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 120_000) throw new Error("tui_timeout_invalid");
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 0;
    this.streamTotalTimeoutMs = options.streamTotalTimeoutMs ?? 0;
    if (!Number.isSafeInteger(this.streamIdleTimeoutMs) || this.streamIdleTimeoutMs < 0 || this.streamIdleTimeoutMs > 120_000
      || !Number.isSafeInteger(this.streamTotalTimeoutMs) || this.streamTotalTimeoutMs < 0 || this.streamTotalTimeoutMs > 30 * 60_000) throw new Error("tui_stream_timeout_invalid");
  }

  get authenticated(): boolean { return this.token !== undefined; }
  get url(): string { return this.baseUrl; }

  /** Provider identities are core registry ids, never API URLs or credentials. */
  setSelectedProvider(providerId?: string, routingComboId?: string, connectionId?: string, modelId?: string): void {
    if (providerId !== undefined && !isProvider(providerId)) throw new Error("tui_provider_invalid");
    if (routingComboId !== undefined && (!providerId || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(routingComboId))) throw new Error("tui_routing_combo_invalid");
    this.selectedDestination = Object.freeze({
      ...(providerId ? { providerId } : {}),
      ...(routingComboId ? { routingComboId } : {}),
      ...(connectionId ? { connectionId } : (providerId ? { connectionId: providerId } : {})),
      ...(modelId ? { modelId } : {})
    });
  }

  setSelectedDestination(destination: ModelDestination): void {
    if (!destination.connectionId || !destination.providerId || !destination.modelId) throw new Error("model_destination_invalid");
    if (!isProvider(destination.providerId)) throw new Error("tui_provider_invalid");
    this.selectedDestination = Object.freeze({
      connectionId: destination.connectionId,
      providerId: destination.providerId,
      modelId: destination.modelId
    });
  }

  getSelectedDestination(): TuiInferenceDestination { return this.selectedDestination; }

  private defaultHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    if (extra) Object.assign(h, extra);
    return h;
  }


  async health(): Promise<CoreHealth> {
    try {
      const res = await this.fetch("/health", {}, 0, Math.min(this.requestTimeoutMs, 5_000));
      const body = await res.json() as Record<string, unknown>;
      if (body.status !== "ok") return { status: "error" };
      return { status: "ok", version: String(body.version ?? ""), uptime: Number(body.uptime ?? 0) };
    } catch {
      return { status: "error" };
    }
  }

  async authenticate(token: string): Promise<boolean> {
    this.token = token;
    try {
      const res = await this.fetch("/v1/models", {}, 0, Math.min(this.requestTimeoutMs, 5_000));
      await cancelStreamWithin(res.body);
      if (res.ok) {
        this.emit("authenticated");
        return true;
      }
      this.token = undefined;
      return false;
    } catch {
      this.token = undefined;
      return false;
    }
  }

  async getModels(): Promise<Array<{ id: string; owned_by?: string }>> {
    const res = await this.fetch("/v1/models");
    const body = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
    return body.data ?? [];
  }

  /** Provider status as reported by `/v1/connections` (`providers[]`). */
  async getConnections(): Promise<Array<{ provider: string; status: string; models?: string[] }>> {
    const res = await this.fetch("/v1/connections");
    const body = await res.json() as { providers?: Array<{ id?: string; models?: string[]; admission?: { eligible?: boolean; reason?: string | null } }> };
    return (body.providers ?? []).filter((p) => typeof p.id === "string").map((p) => ({
      provider: p.id!, status: p.admission?.eligible ? "available" : (p.admission?.reason ?? "unavailable"), models: p.models ?? [],
    }));
  }

  async getUsage(): Promise<Record<string, unknown>> {
    const res = await this.fetch("/v1/usage");
    return await res.json() as Record<string, unknown>;
  }

  /** Every saved conversation (cursor pages followed, cycle-safe, bounded at 40 pages). */
  async getConversations(): Promise<Array<{ id: string; title?: string; updatedAt?: string; projectId?: string | null }>> {
    const out: Array<{ id: string; title?: string; updatedAt?: string; projectId?: string | null }> = [];
    const seen = new Set<string>();
    let after = "";
    for (let page = 0; page < 40; page++) {
      const res = await this.fetch(`/v1/workspace/conversations?limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      const body = await res.json() as {
        conversations?: Array<{ id: string; title?: string; updated_at?: string; updatedAt?: string; projectId?: string | null }>;
        nextCursor?: string | null;
      };
      for (const c of body.conversations ?? []) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt ?? c.updated_at, projectId: c.projectId ?? null });
      if (!body.nextCursor || seen.has(body.nextCursor)) break;
      seen.add(body.nextCursor);
      after = body.nextCursor;
    }
    return out;
  }

  async createConversation(
    title?: string,
    storagePolicy: "local" | "temporary" = "local",
    processingPolicy: "local_only" | "external_allowed" = "local_only",
    projectId?: string,
  ): Promise<{ id: string }> {
    const res = await this.fetch("/v1/workspace/conversations/create", {
      method: "POST",
      body: JSON.stringify({ title, storagePolicy, processingPolicy, ...(projectId ? { projectId } : {}) }),
    });
    return await res.json() as { id: string };
  }

  /** Canonical CAS-gated deletion via the core conversation service (T07). */
  async deleteConversation(conversationId: string, expectedRevision: number): Promise<void> {
    const res = await this.fetch(`/v1/workspace/conversations/${encodeURIComponent(conversationId)}/delete`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    });
    if (!res.ok) throw new Error(`conversation_delete_failed_${res.status}`);
  }

  async getMessages(conversationId: string, after?: string): Promise<Array<Record<string, unknown>>> {
    const messages: Array<Record<string, unknown>> = [];
    const cursors = new Set<string>();
    let cursor = after;
    for (let page = 0; page < 501; page++) {
      const params = `?limit=200${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
      const res = await this.fetch(`/v1/workspace/conversations/${encodeURIComponent(conversationId)}/messages${params}`);
      const body = await res.json() as { messages?: Array<Record<string, unknown>>; nextCursor?: string | null };
      if (!Array.isArray(body.messages)) throw new Error("conversation_history_invalid");
      messages.push(...body.messages);
      if (!body.nextCursor) return messages;
      if (typeof body.nextCursor !== "string" || cursors.has(body.nextCursor)) throw new Error("conversation_history_invalid");
      cursor = body.nextCursor; cursors.add(cursor);
    }
    throw new Error("conversation_history_incomplete");
  }

  serializeChatInput(model: string, messages: Array<{ role: string; content: string | MediaDispatchPart[] }>, destination: TuiInferenceDestination = this.selectedDestination, tools?: readonly TuiFunctionTool[]): string {
    if (destination.providerId !== undefined && !isProvider(destination.providerId)) throw new Error("tui_provider_invalid");
    if (destination.routingComboId !== undefined && (!destination.providerId || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(destination.routingComboId))) throw new Error("tui_routing_combo_invalid");
    const body: Record<string, unknown> = { model, messages, stream: true };
    const media = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    const required = [...new Set(media.flatMap(part => part.type === "image_url" ? ["image"] : part.type === "input_audio" ? ["audio"] : []))];
    if (required.length) body.uptokey_require_input = required;
    if (destination.connectionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(destination.connectionId)) body.uptokey_account = destination.connectionId;
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
      // Read tools run serially against the currently authorized project root.
      body.parallel_tool_calls = false;
    }
    if (destination.providerId) {
      // Core intersects this exact destination with scope/privacy/quota controls,
      // then removes the routing fields before sending the provider envelope.
      body.uptokey_provider = destination.providerId;
      body.uptokey_require_model = true;
      if (destination.routingComboId) body.uptokey_routing_combo = destination.routingComboId;
    }

    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > MAX_INFERENCE_REQUEST_BYTES) throw new Error("attachment_size");
    return serialized;
  }

  /** Account credentials remain in the core/BFF; these projections contain only verified public fields. */
  private async accountRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetchRaw(`/local/account/${path}`, {
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
    });
    const parsed = await readBoundedJson(response, ["available", "requests"].includes(path) ? ACCOUNT_MAX_CLIENT_RESPONSE_BYTES : ACCOUNT_MAX_RESPONSE_BYTES);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) throw new Error("account_response_invalid");
    const row = parsed.value as Record<string, unknown>;
    if (!response.ok) {
      const error = typeof row.error === "string" ? row.error : (row.error as { type?: unknown } | undefined)?.type;
      throw new Error(typeof error === "string" && /^account_[a-z_]{1,80}$/.test(error) ? error : "account_service_unavailable");
    }
    return row;
  }

  async getAccountSession(signal?: AbortSignal): Promise<AccountPublicSession> {
    return readAccountPublicSession(await this.accountRequest("status", undefined, signal));
  }

  async getAvailableAccounts(signal?: AbortSignal): Promise<TuiAccountAvailable> {
    return readAccountAvailable(await this.accountRequest("available", undefined, signal));
  }

  async startAccountLogin(signal?: AbortSignal): Promise<TuiAccountLogin> {
    const row = await this.accountRequest("login", {}, signal);
    if (row.session !== undefined) return { session: readAccountPublicSession(row.session) };
    if (typeof row.loginUrl !== "string" || typeof row.userCode !== "string" || !/^[A-Z0-9]{8}$/.test(row.userCode) || !Number.isSafeInteger(row.expiresAt) || Number(row.expiresAt) <= Date.now() || Number(row.expiresAt) > Date.now() + 6 * 60_000) throw new Error("account_response_invalid");
    let url: URL;
    try { url = new URL(row.loginUrl); } catch { throw new Error("account_response_invalid"); }
    if (url.username || url.password || url.hash || url.pathname !== "/api/account/native/authorize" || [...url.searchParams.keys()].length !== 1 || !ACCOUNT_ID.test(url.searchParams.get("id") ?? "") || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("account_response_invalid");
    return { loginUrl: url.href, userCode: row.userCode, expiresAt: Number(row.expiresAt) };
  }

  async adoptAccount(accountRef: string, expectedRevision: number, signal?: AbortSignal): Promise<TuiAccountMutation> {
    return this.accountMutation("adopt", { accountRef, expectedRevision }, signal);
  }

  async unlinkAccount(expectedRevision: number, signal?: AbortSignal): Promise<TuiAccountMutation> {
    return this.accountMutation("unlink", { expectedRevision }, signal);
  }

  private async accountMutation(path: string, body: unknown, signal?: AbortSignal): Promise<TuiAccountMutation> {
    return readAccountAdoption(await this.accountRequest(path, body, signal));
  }

  async signOutAccount(signal?: AbortSignal): Promise<AccountPublicSession> {
    return readAccountPublicSession(await this.accountRequest("logout", {}, signal));
  }

  async getAccountUsage(signal?: AbortSignal): Promise<AccountPublicUsage> {
    return readAccountPublicUsage(await this.accountRequest("usage", undefined, signal));
  }

  async requestAccountAccess(signal?: AbortSignal): Promise<TuiAccountChallenge> {
    return this.readAccountChallenge(await this.accountRequest("request", {}, signal));
  }

  private readAccountChallenge(row: Record<string, unknown>): TuiAccountChallenge {
    const result = readAccountShareChallenge(row), expiresAt = Date.parse(result.expiresAt);
    if (expiresAt <= Date.now() || expiresAt > Date.now() + 6 * 60_000) throw new Error("account_response_invalid");
    return result;
  }

  async getAccountRequests(signal?: AbortSignal): Promise<TuiAccountRequest[]> {
    return readAccountShareRequests(await this.accountRequest("requests", undefined, signal)).requests;
  }

  async approveAccountRequest(id: string, userCode: string, accountRef: string, signal?: AbortSignal): Promise<void> {
    readAccountShareApproval(await this.accountRequest("approve", { id, userCode, accountRef }, signal));
  }

  async consumeAccountAccess(id: string, signal?: AbortSignal): Promise<void> {
    readAccountShareApproval(await this.accountRequest("consume", { id }, signal));
  }

  async *chatStream(model: string, messages: Array<{ role: string; content: string | MediaDispatchPart[] }>, conversationId?: string, processingPolicy?: string, signal?: AbortSignal, destination: TuiInferenceDestination = this.selectedDestination, tools?: readonly TuiFunctionTool[]): AsyncGenerator<StreamEvent> {
    const serialized = this.serializeChatInput(model, messages, destination, tools);
    const extraHeaders: Record<string, string> = {};
    if (conversationId) extraHeaders["x-uptokey-conversation-id"] = conversationId;
    if (processingPolicy) extraHeaders["x-uptokey-processing-policy"] = processingPolicy;
    const res = await this.fetch("/v1/chat/completions", {
      method: "POST", body: serialized, headers: extraHeaders, signal,
    }, 0, this.requestTimeoutMs, true, true);
    if (!res.body || !res.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      await cancelStreamWithin(res.body);
      throw new Error("stream_content_type_invalid");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const events: StreamEvent[] = [];
    let done = false;
    let parseError: Error | undefined;
    const parser = createParser({ maxBufferSize: 131_072, onError: () => { parseError = new Error("stream_invalid"); }, onEvent: ({ data }) => {
      if (done || parseError) return;
      if (data === "[DONE]") { done = true; events.push({ type: "done", data: "" }); return; }
      try {
        const parsed: unknown = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        const chunk = parsed as Record<string, unknown>;
        if (chunk.error !== undefined) { parseError = new Error("stream_upstream_error"); return; }
        const delta = (chunk.choices as Array<{ delta?: { content?: unknown; tool_calls?: unknown } }> | undefined)?.[0]?.delta;
        if (delta?.content != null) {
          if (typeof delta.content !== "string") throw new Error();
          if (delta.content) events.push({ type: "text", data: delta.content, ...(typeof chunk.id === "string" ? { id: chunk.id } : {}) });
        }
        if (delta?.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new Error();
          events.push({ type: "tool_call", data: JSON.stringify(delta.tool_calls) });
        }
      } catch { parseError = new Error("stream_invalid"); }
    }});
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          if (!done) throw new Error("stream_interrupted");
          return;
        }
        try { parser.feed(decoder.decode(next.value, { stream: true })); }
        catch { parseError = new Error("stream_invalid"); }
        // Deliver complete frames already received before reporting a later bad frame.
        for (const event of events.splice(0)) yield event;
        if (parseError) throw parseError;
        if (done) return;
      }
    } finally {
      await cancelStreamWithin(reader);
      reader.releaseLock();
    }
  }

  async readProjectRunOutput(projectId: string, runId: string, after: number = 0, limit: number = 500): Promise<{events: any[]; cursor: number; dropped: boolean; done: boolean} | null> {
    const res = await this.fetch(`/v1/workspace/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/output?after=${after}&limit=${limit}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`output_read_failed_${res.status}`);
    return res.json() as Promise<{events: any[]; cursor: number; dropped: boolean; done: boolean}>;
  }

  async deleteProjectRunOutput(projectId: string, runId: string): Promise<boolean> { const res = await this.fetch(`/v1/workspace/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/output`, { method: "DELETE" }); return res.ok; } async cancelRun(conversationId: string, runId: string): Promise<boolean> {
    try {
      const res = await this.fetch(`/v1/workspace/conversations/${conversationId}/runs/${runId}/cancel`, {
        method: "POST",
      });
      return res.ok;
    } catch { return false; }
  }
  /** Public authenticated fetch for workspace service consumers. */
  async fetchAuth(path: string, init?: RequestInit): Promise<Response> {
    return this.fetch(path, init);
  }

  /**
   * Same loopback/credential boundary as fetchAuth, but returns 4xx/5xx responses
   * for structured reconciliation (no retry, no thrown http_ status). Transport
   * failures still throw; write outcomes remain unknown to the caller, never replayed.
   */
  async fetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(path, this.baseUrl);
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || target.origin !== this.baseUrl || target.username || target.password || target.hash) throw new Error("tui_request_path_invalid");
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", "Bearer " + this.token);
    else headers.delete("authorization");
    const deadline = createDeadline(this.requestTimeoutMs);
    const signal = AbortSignal.any([this.lifetimeSignal, deadline.signal, ...(init.signal ? [init.signal] : [])]);
    const abortError = () => deadline.signal.aborted ? new Error("tui_request_timeout") : new DOMException("aborted", "AbortError");
    let transferred = false;
    try {
      if (signal.aborted) throw abortError();
      let response: Response;
      try {
        response = await fetch(target, { ...init, headers, signal, redirect: "error" });
      } catch {
        if (signal.aborted) throw abortError();
        throw new Error("tui_transport_unavailable");
      }
      if (signal.aborted) { await cancelStreamWithin(response.body); throw abortError(); }
      if (!response.body) return response;
      const wrapped = retainRequestLifetime(response, signal, deadline.clear, abortError);
      transferred = true;
      return wrapped;
    } finally {
      if (!transferred) deadline.clear();
    }
  }

  /** Native enrollment uses the same lifetime/loopback boundary, without a bearer credential. */
  async requestNativeSession(step: "challenge" | "complete", body: Record<string, unknown>): Promise<unknown> {
    if (step !== "challenge" && step !== "complete") throw new Error("tui_request_path_invalid");
    const timeoutMs = Math.min(this.requestTimeoutMs, 10_000);
    const response = await this.fetch(`/local/workspace/session/${step}`, {
      method: "POST", headers: { Origin: "uptokey-tui://local" }, body: JSON.stringify(body),
    }, 0, timeoutMs, false);
    const parsed = await readBoundedJson(response, 8192, timeoutMs);
    if (!parsed.ok) throw new Error((parsed as any).reason === "too_large" ? "tui_auth_response_too_large" : "tui_auth_response_invalid");
    return parsed.value;
  }

  /**
   * Explicit pairing bootstrap (audience tui). No bearer and no fabricated Origin:
   * the server decides authority from the approved challenge. HTTP error statuses
   * are returned (not thrown) so the caller can branch on structured codes.
   */
  async postPairing(path: "/local/pair/challenge" | "/local/pair/consume", body: Record<string, unknown>, timeoutMs = 10_000): Promise<{ status: number; value: unknown }> {
    const target = new URL(path, this.baseUrl);
    if (target.origin !== this.baseUrl || target.username || target.password || target.hash) throw new Error("tui_request_path_invalid");
    const deadline = createDeadline(Math.min(this.requestTimeoutMs, timeoutMs));
    const signal = AbortSignal.any([this.lifetimeSignal, deadline.signal]);
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: "uptokey-tui://local" },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      const parsed = await readBoundedJson(response, 8192, Math.min(this.requestTimeoutMs, timeoutMs));
      if (!parsed.ok) throw new Error((parsed as any).reason === "too_large" ? "tui_pairing_response_too_large" : "tui_pairing_response_invalid");
      return { status: response.status, value: parsed.value };
    } finally {
      deadline.clear();
    }
  }

  private async fetch(path: string, init: RequestInit = {}, retries = 2, timeoutMs = this.requestTimeoutMs, includeCredential = true, streaming = false): Promise<Response> {
    const target = new URL(path, this.baseUrl);
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || target.origin !== this.baseUrl || target.username || target.password || target.hash) throw new Error("tui_request_path_invalid");
    const method = (init.method ?? "GET").toUpperCase();
    // A write may have committed before its response was lost. The core owns
    // operation replay/reconciliation; transport retries only safe reads.
    const maxRetries = method === "GET" || method === "HEAD" ? retries : 0;
    const deadline = createDeadline(timeoutMs);
    const streamAbort = new AbortController();
    const signal = AbortSignal.any([this.lifetimeSignal, deadline.signal, streamAbort.signal, ...(init.signal ? [init.signal] : [])]);
    let streamTimeout: "tui_stream_idle_timeout" | "tui_stream_total_timeout" | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    const abortError = () => streamTimeout ? new Error(streamTimeout) : deadline.signal.aborted ? new Error("tui_request_timeout") : new DOMException("aborted", "AbortError");
    const clear = () => { deadline.clear(); clearTimeout(idleTimer); clearTimeout(totalTimer); };
    const refreshIdle = () => {
      clearTimeout(idleTimer);
      if (this.streamIdleTimeoutMs > 0 && !signal.aborted) idleTimer = setTimeout(() => { streamTimeout = "tui_stream_idle_timeout"; streamAbort.abort(); }, this.streamIdleTimeoutMs);
    };
    let transferred = false;
    try {
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw abortError();
        const headers = new Headers(init.headers);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
        // The client identity cannot be replaced by a per-operation header.
        if (includeCredential && this.token) headers.set("authorization", "Bearer " + this.token);
        else headers.delete("authorization");
        let response: Response;
        try {
          response = await inferenceFetch(target, { ...init, method, headers, signal, redirect: "error" }, streaming);
        } catch {
          if (signal.aborted) throw abortError();
          if (attempt >= maxRetries) throw new Error("tui_transport_unavailable");
          try { await delay(250 * 2 ** attempt, undefined, { signal }); } catch { throw abortError(); }
          continue;
        }
        if (signal.aborted) { await cancelStreamWithin(response.body); throw abortError(); }
        if ([429, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
          await cancelStreamWithin(response.body);
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
          const dateDelay = retryAfter === null ? NaN : Date.parse(retryAfter) - Date.now();
          const waitMs = Math.min(30_000, Math.max(0, Number.isFinite(seconds) ? seconds * 1_000 : Number.isFinite(dateDelay) ? dateDelay : 250 * 2 ** attempt));
          try { await delay(waitMs, undefined, { signal }); } catch { throw abortError(); }
          continue;
        }
        if (!response.ok) {
          // Keep the status-shaped message (callers match on it) and expose the
          // structured `{error:{type}}` code when the body carries one.
          const code = await readErrorType(response);
          if (response.status === 401 || response.status === 403) { this.emit("auth_error", response.status); throw new TuiHttpError("auth_" + response.status, response.status, code); }
          throw new TuiHttpError("http_" + response.status, response.status, code);
        }
        if (!response.body) return response;
        const sse = streaming && response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
        if (sse) {
          // Generation may be silent while the model reasons. Only explicitly
          // requested SSE bounds apply; user/lifetime cancellation stays attached.
          deadline.clear();
          if (this.streamTotalTimeoutMs > 0) totalTimer = setTimeout(() => { streamTimeout = "tui_stream_total_timeout"; streamAbort.abort(); }, this.streamTotalTimeoutMs);
          refreshIdle();
        }
        const wrapped = retainRequestLifetime(response, signal, clear, abortError, sse ? refreshIdle : undefined);
        transferred = true;
        return wrapped;
      }
    } finally { if (!transferred) clear(); }
  }


  destroy(): void {
    this.abortController.abort();
    this.token = undefined;
    this.selectedDestination = Object.freeze({});
    this.removeAllListeners();
  }
}

/** HTTP failure with the status-shaped message kept and the core error type attached. */
export class TuiHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "TuiHttpError";
    this.status = status;
    this.code = code;
  }
}

async function readErrorType(response: Response): Promise<string | null> {
  try {
    const parsed = await readBoundedJson(response, 4096, 2_000);
    if (!parsed.ok) return null;
    const value = parsed.value as { error?: { type?: unknown; upstream_status?: unknown } } | null;
    const type = value?.error?.type;
    // The provider answered 404 to the request: the model is not available to this account (unknown model, or one
    // the provider gates, e.g. behind organization verification). Say so instead of a generic rejection.
    if (type === "provider_request_rejected" && value?.error?.upstream_status === 404) return "provider_model_unavailable";
    return typeof type === "string" && /^[a-z0-9_]{1,64}$/.test(type) ? type : null;
  } catch {
    await cancelStreamWithin(response.body).catch(() => undefined);
    return null;
  }
}

/** Discover the core endpoint. Uses configured port or default 21435. */
export function discoverCoreUrl(port?: number): string {
  const selected = port ?? 21435;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 65535) throw new Error("tui_port_invalid");
  return `http://127.0.0.1:${selected}`;
}



/** Keep cancellation/deadline attached until EOF, consumer cancellation or error. */
function retainRequestLifetime(response: Response, signal: AbortSignal, clear: () => void, abortError: () => Error, progress?: () => void): Response {
  const reader = response.body!.getReader();
  let closed = false;
  let onAbort: () => void;
  const cleanup = () => { clear(); signal.removeEventListener("abort", onAbort); };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (closed) return;
        closed = true; cleanup(); controller.error(abortError());
        void cancelStreamWithin(reader).finally(() => { try { reader.releaseLock(); } catch {} });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      if (closed) return;
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) { closed = true; cleanup(); reader.releaseLock(); controller.close(); }
        else { if (next.value.byteLength > 0) progress?.(); controller.enqueue(next.value); }
      } catch {
        if (!closed) { closed = true; cleanup(); controller.error(signal.aborted ? abortError() : new Error("tui_response_interrupted")); }
        try { reader.releaseLock(); } catch {}
      }
    },
    async cancel() {
      if (closed) return;
      closed = true; cleanup(); await cancelStreamWithin(reader);
      try { reader.releaseLock(); } catch {}
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

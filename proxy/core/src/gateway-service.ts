import { randomUUID } from "node:crypto";
import { createParser } from "eventsource-parser";
import type { ChildProcess } from "node:child_process";
import {
  canonicalGatewayChatPayload, canonicalGatewayWirePayload, parseGatewayChatRequest, parseGatewayWireRequest,
  parseGatewayToolProposal, parseGatewayProtocolRequest, GATEWAY_TOOL_MAX_COUNT, GATEWAY_CHAT_MAX_BYTES,
  type GatewayChatRequest, type GatewayWireRequest, type GatewayProtocolRequest,
} from "@uptokey/sync-contract/gateway";
import { MAX_INFERENCE_REQUEST_BYTES, readBoundedJson } from "@uptokey/sync-contract/limits";
import { isDataRecord } from "@uptokey/sync-contract/plain-data";
import type { EffectRequest } from "./workspace/executor.ts";
import type { WorkspaceStore } from "./workspace/store.ts";
import { cancelStream } from "./stream-lifecycle.ts";
import {openGatewayProtocolStream,type GatewayProtocolStream,type ProtocolStreamIdentity,type SendProtocolStream} from './gateway-protocol-stream.ts';
import type { DispatchBudgetReservation } from './types.ts';

export type GatewayAccountFunding = (chat: GatewayChatRequest, wire: GatewayWireRequest, effect: EffectRequest, signal: AbortSignal) => Promise<DispatchBudgetReservation | undefined>;
/** Current destination authority; independent of commercial funding or quota reservations. */
export type GatewayDispatchAuthority = (wire: GatewayWireRequest, signal: AbortSignal) => Promise<void>;

export type GatewayProtocolProjection={protocol:GatewayProtocolRequest['protocol'];approvedTools?:GatewayChatRequest['tools']}&
  ({completion:unknown;rawSSE?:never}|{rawSSE:string;completion?:never});
export class GatewayProtocolProjectionError extends Error {
  readonly code:'gateway_protocol_usage_unknown'|'gateway_protocol_output_invalid';
  constructor(code:'gateway_protocol_usage_unknown'|'gateway_protocol_output_invalid'){super(code);this.code=code;}
}
export interface WorkspaceGateway {
  readonly model: string;
  readonly available?: boolean;
  /** F2: non-text content parts this lane can carry to its destination. Absent means text only. */
  readonly inputParts?: readonly ("image" | "audio")[];
  /** App-owned commercial identity/admission; never accepted over child IPC. */
  attachAccountFunding?(reserve: GatewayAccountFunding): void;
  attachDispatchAuthority?(validate: GatewayDispatchAuthority): void;
  /** Pure upstream translation; no provider dispatch or credential resolution. */
  normalizeProtocol?(request: GatewayProtocolRequest, signal: AbortSignal): Promise<GatewayChatRequest>;
  projectProtocolOutput?(request:GatewayProtocolProjection,signal:AbortSignal):Promise<Record<string,unknown>>;
  openProtocolStream?(protocol:GatewayProtocolRequest['protocol'],identity:ProtocolStreamIdentity,tools:GatewayChatRequest['tools']|undefined,signal:AbortSignal):Promise<GatewayProtocolStream>;
  prepare(chat: GatewayChatRequest, signal: AbortSignal): Promise<GatewayWireRequest>;
  execute(chat: GatewayChatRequest, wire: GatewayWireRequest, effect: EffectRequest): Promise<Response>;
}

export interface IpcWorkspaceGatewayOptions {
  child: ChildProcess;
  model: string;
  providerModel: string;
  providerUrl: string;
  driverRevision: string;
  sendChat(chat: GatewayChatRequest, requestId: string, signal: AbortSignal): Promise<Response>;
  sendProtocol?(request: GatewayProtocolRequest, requestId: string, signal: AbortSignal): Promise<Response>;
  sendProjection?(request:GatewayProtocolProjection,requestId:string,signal:AbortSignal):Promise<Response>;
  sendProtocolStream?:SendProtocolStream;
  store: Pick<WorkspaceStore, "readRun">;
  resolveCredential(): Promise<string>;
  /** Parent admission work, such as a shared quota reservation; never called while preparing. */
  beforeDispatch?(chat: GatewayChatRequest, wire: GatewayWireRequest, effect: EffectRequest, signal: AbortSignal): Promise<void>;
  fetchImpl?: typeof fetch;
  prepareTimeoutMs?: number;
}

type Slot = {
  requestId: string;
  controller: AbortController;
  deadline: number;
  mode: "prepare" | "execute";
  chat: GatewayChatRequest;
  dispatchSeen: boolean;
  responded: boolean;
  dispatchedId?: string;
  prepared?: GatewayWireRequest;
  approved?: GatewayWireRequest;
  effect?: EffectRequest;
  secret?: string;
  streamingReturned?: boolean;
  released?: boolean;
  funding?: DispatchBudgetReservation;
  fundingRelease?: Promise<void>;
  providerDispatched?: boolean;
  /** Account refusal observed before the provider transport; reported as not sent. */
  refusal?: string;
  stream?: { reader: ReadableStreamDefaultReader<Uint8Array>; reading: boolean; pendingPull?: boolean };
  cleanup(): void;
};

const failure = () => new Error("gateway_operation_failed");
/** Account admission refused before the parent invoked the provider transport: nothing was sent. */
export class GatewayNotSentError extends Error {
  readonly outcome = "not_sent" as const;
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const refusalCode = (error: unknown) => error instanceof Error && /^(budget_[a-z_]{1,60}|account_funding_[a-z_]{1,60}|input_(image|audio|tools|json_schema)_undeclared)$/.test(error.message) ? error.message : undefined;
/** F2: whether an approved wire body carries an `input_audio` part (the native audio lane). */
export function gatewayWireHasAudio(body: string): boolean {
  let request: unknown;
  try { request = JSON.parse(body); } catch { return false; }
  const messages = (request as { messages?: unknown })?.messages;
  return Array.isArray(messages) && messages.some(message => Array.isArray((message as { content?: unknown })?.content)
    && ((message as { content: unknown[] }).content).some(part => (part as { type?: unknown })?.type === "input_audio"));
}
const validMessageId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Parent-only transport. Lifecycle, policy approval and child startup belong to the caller. */
export class IpcWorkspaceGateway implements WorkspaceGateway {
  readonly model: string;
  private readonly options: IpcWorkspaceGatewayOptions;
  private slot?: Slot;
  private normalization?: AbortController;
  private disposed = false;
  private accountFunding?: GatewayAccountFunding;
  private dispatchAuthority?: GatewayDispatchAuthority;
  private translationLifetime = new AbortController();
  // W3 owns durable recovery. This set also prevents reuse before W3 settles a receipt.
  private readonly consumed = new Set<string>();
  private readonly onMessage = (message: unknown): void => { void this.handleMessage(message); };
  private readonly onClosed = (): void => { this.dispose(); };

  constructor(options: IpcWorkspaceGatewayOptions) {
    const url = new URL(options.providerUrl);
    if (url.href !== options.providerUrl || url.username || url.password || url.search || url.hash ||
        !(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1") ||
        !url.pathname.endsWith("/chat/completions") || !/^[a-f0-9]{40}$/.test(options.driverRevision)) throw failure();
    if (options.prepareTimeoutMs !== undefined && (!Number.isSafeInteger(options.prepareTimeoutMs) || options.prepareTimeoutMs < 1 || options.prepareTimeoutMs > 120_000)) throw failure();
    if (typeof options.providerModel !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(options.providerModel)) throw failure();
    this.options = { ...options };
    this.model = options.model;
    options.child.on("message", this.onMessage);
    options.child.on("disconnect", this.onClosed);
    options.child.on("exit", this.onClosed);
    options.child.on("error", this.onClosed);
  }

  attachAccountFunding(reserve: GatewayAccountFunding): void {
    if (this.slot || this.disposed) throw failure();
    this.accountFunding = reserve;
  }

  attachDispatchAuthority(validate: GatewayDispatchAuthority): void {
    if (this.slot || this.disposed) throw failure();
    this.dispatchAuthority = validate;
  }

  private async validateDispatchAuthority(slot: Slot, wire: GatewayWireRequest): Promise<void> {
    if (this.dispatchAuthority) await untilAbort(this.dispatchAuthority(wire, slot.controller.signal).catch(error => {
      slot.refusal = refusalCode(error); throw error;
    }), slot.controller.signal);
    this.assertLive(slot);
  }

  async normalizeProtocol(input: GatewayProtocolRequest, signal: AbortSignal): Promise<GatewayChatRequest> {
    const request=parseGatewayProtocolRequest(input);
    const send=this.options.sendProtocol;if(!send)throw failure();
    return this.chat(await this.localProjection((id,current)=>send(request,id,current),'chat',GATEWAY_CHAT_MAX_BYTES+64,signal));
  }
  async projectProtocolOutput(input:GatewayProtocolProjection,signal:AbortSignal):Promise<Record<string,unknown>> {
    const send=this.options.sendProjection;if(!send)throw failure();
    const request=structuredClone(input);
    return this.localProjection((id,current)=>send(request,id,current),'response',131072,signal);
  }
  async openProtocolStream(protocol:GatewayProtocolRequest['protocol'],identity:ProtocolStreamIdentity,tools:GatewayChatRequest['tools']|undefined,signal:AbortSignal):Promise<GatewayProtocolStream> {
    const send=this.options.sendProtocolStream;
    if(this.disposed||!this.options.child.connected||!send)throw failure();
    return openGatewayProtocolStream((command,id,current)=>untilAbort(send(command,id,current),current),protocol,identity,tools,AbortSignal.any([signal,this.translationLifetime.signal]));
  }
  private async localProjection(send:(id:string,signal:AbortSignal)=>Promise<Response>,field:string,maxBytes:number,signal:AbortSignal):Promise<Record<string,unknown>> {
    if(this.disposed||!this.options.child.connected||this.slot||this.normalization)throw failure();
    const controller=new AbortController();this.normalization=controller;
    const combined=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(this.options.prepareTimeoutMs??30_000)]);
    try{
      combined.throwIfAborted();
      const response=await untilAbort(send(randomUUID(),combined),combined);
      const boundedResponse=new Response(response.body?.pipeThrough(new TransformStream(),{signal:combined}),{status:response.status,headers:response.headers});
      const result=await untilAbort(readBoundedJson(boundedResponse,maxBytes,30_000),combined);
      combined.throwIfAborted();
      if(field==='response'&&response.status===400&&result.ok&&isDataRecord(result.value)&&Object.keys(result.value).join(',')==='error'){
        if(result.value.error==='quimera_protocol_usage_unknown')throw new GatewayProtocolProjectionError('gateway_protocol_usage_unknown');
        if(result.value.error==='quimera_protocol_output_invalid')throw new GatewayProtocolProjectionError('gateway_protocol_output_invalid');
      }
      if(!response.ok||!result.ok||!isDataRecord(result.value)||Object.keys(result.value).join(',')!==field||!isDataRecord(result.value[field]))throw failure();
      return result.value[field];
    }finally{controller.abort();if(this.normalization===controller)this.normalization=undefined;}
  }

  async prepare(input: GatewayChatRequest, signal: AbortSignal): Promise<GatewayWireRequest> {
    const chat = this.chat(input);
    const slot = this.acquire("prepare", chat, signal, this.options.prepareTimeoutMs ?? 30_000);
    try {
      const response = await this.invoke(chat, slot);
      if (!response.ok || !slot.prepared) throw failure();
      return slot.prepared;
    } finally { this.release(slot); }
  }

  async execute(input: GatewayChatRequest, inputWire: GatewayWireRequest, effect: EffectRequest): Promise<Response> {
    const chat = this.chat(input);
    const wire = this.wire(inputWire, chat);
    const approvedChat = effect.arguments.chat;
    const approvedWire = effect.arguments.wire;
    if (approvedChat?.kind !== "literal" || approvedWire?.kind !== "literal" ||
        canonicalGatewayChatPayload(approvedChat.value) !== canonicalGatewayChatPayload(chat) ||
        canonicalGatewayWirePayload(approvedWire.value) !== canonicalGatewayWirePayload(wire) ||
        chat.max_tokens > effect.limits.maxOutputTokens ||
        effect.capability.effect !== "inference" || effect.capability.dataDestination.kind !== "provider" ||
        effect.capability.retryClass !== "never_automatic") throw failure();
    const remaining = Math.min(Date.parse(effect.deadlineAt) - Date.now(), effect.limits.timeoutMs);
    if (!Number.isFinite(remaining) || remaining < 1 || !Number.isSafeInteger(effect.limits.maxOutputBytes) || effect.limits.maxOutputBytes < 1) throw failure();
    const slot = this.acquire("execute", chat, effect.signal, Math.min(remaining, 120_000));
    slot.approved = wire;
    // Snapshot arguments so mutation during async admission cannot change the authorized effect.
    slot.effect = { ...effect, capability: structuredClone(effect.capability), limits: { ...effect.limits }, arguments: structuredClone(effect.arguments) };
    try {
      const response = await this.invoke(chat, slot);
      if (!slot.dispatchSeen || !slot.responded) throw failure();
      return response;
    } catch (error) {
      // Only the parent invokes the provider transport, so an account refusal before it is certain.
      if (!slot.providerDispatched && slot.refusal) throw new GatewayNotSentError(slot.refusal);
      throw error;
    } finally { if (!slot.streamingReturned) this.release(slot); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.translationLifetime.abort();
    this.normalization?.abort(failure());
    this.options.child.off("message", this.onMessage);
    this.options.child.off("disconnect", this.onClosed);
    this.options.child.off("exit", this.onClosed);
    this.options.child.off("error", this.onClosed);
    if (this.slot) this.release(this.slot);
    this.consumed.clear();
  }

  private chat(input: unknown): GatewayChatRequest {
    const chat = parseGatewayChatRequest(input);
    if (chat.model !== this.model) throw failure();
    return chat;
  }

  private wire(input: unknown, chat: GatewayChatRequest): GatewayWireRequest {
    const wire = parseGatewayWireRequest(input);
    if (wire.url !== this.options.providerUrl || wire.driverRevision !== this.options.driverRevision ||
        wire.model !== this.options.providerModel || !chat.stream && wire.headers.accept === "text/event-stream") throw failure();
    // This profile permits only alias translation; messages, limits and exact allowed fields stay bound to the approved chat.
    // The strict chat parser also rejects a missing max_tokens or a competing max_completion_tokens.
    const body = JSON.parse(wire.body);
    if (canonicalGatewayChatPayload({ ...body, model: chat.model }) !== canonicalGatewayChatPayload(chat)) throw failure();
    return wire;
  }

  private acquire(mode: Slot["mode"], chat: GatewayChatRequest, signal: AbortSignal, timeout: number): Slot {
    if (this.disposed || !this.options.child.connected) throw failure();
    if (this.slot || this.normalization) throw new Error("gateway_busy");
    if (signal.aborted) throw failure();
    const controller = new AbortController();
    const abort = () => controller.abort(failure());
    const timer = setTimeout(abort, Math.ceil(timeout));
    signal.addEventListener("abort", abort, { once: true });
    const slot: Slot = {
      requestId: randomUUID(), mode, chat, controller, deadline: Date.now() + timeout, dispatchSeen: false, responded: false,
      cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); },
    };
    this.slot = slot;
    return slot;
  }

  private release(slot: Slot): void {
    if (slot.released) return;
    slot.released = true;
    slot.cleanup();
    void slot.stream?.reader.cancel().catch(() => undefined);
    slot.stream = undefined;
    slot.controller.abort(failure());
    void this.compensateUnsent(slot).catch(() => undefined);
    slot.secret = undefined;
    if (this.slot === slot) this.slot = undefined;
  }

  private async compensateUnsent(slot: Slot): Promise<void> {
    if (slot.providerDispatched || !slot.funding) return;
    if (slot.fundingRelease) return slot.fundingRelease;
    slot.fundingRelease = slot.funding.compensate().then(() => { slot.funding = undefined; });
    try { await slot.fundingRelease; } finally { slot.fundingRelease = undefined; }
  }

  private assertLive(slot: Slot): void {
    if (this.disposed || this.slot !== slot || slot.controller.signal.aborted || Date.now() >= slot.deadline) throw failure();
  }

  private async invoke(chat: GatewayChatRequest, slot: Slot): Promise<Response> {
    try {
      this.assertLive(slot);
      const request = this.options.sendChat(chat, slot.requestId, slot.controller.signal);
      void request.then(response => { if (slot.controller.signal.aborted) cancelStream(response.body); }, () => undefined);
      const response = await untilAbort(request, slot.controller.signal);
      this.assertLive(slot);
      const maxBytes = slot.effect?.limits.maxOutputBytes ?? MAX_INFERENCE_REQUEST_BYTES;
      if (isSse(response)) {
        if (!chat.stream) { cancelStream(response.body); throw failure(); }
        const stream = this.sse(response, maxBytes, slot, slot.mode === "execute");
        if (slot.mode === "prepare") {
          const reader = stream.getReader();
          try { while (!(await reader.read()).done) { /* Drain the bounded synthetic preview. */ } }
          finally { reader.releaseLock(); }
          return new Response("{}", { status: response.status, headers: { "content-type": "application/json" } });
        }
        slot.streamingReturned = true;
        return new Response(stream, { status: response.status, headers: { "content-type": "text/event-stream" } });
      }
      if (slot.mode === "execute" && chat.stream && response.ok) { cancelStream(response.body); throw failure(); }
      const result = await this.json(response, maxBytes, slot);
      return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } });
    } catch { throw failure(); }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isDataRecord(message) || !validMessageId(message.id) || !validMessageId(message.requestId)) return;
    const slot = this.slot;
    if (message.type === "cancel") {
      if (slot?.requestId === message.requestId && slot.dispatchedId === message.id) slot.controller.abort(failure());
      return;
    }
    if (message.type === "pull") {
      if (slot?.requestId === message.requestId && slot.dispatchedId === message.id) await this.pull(slot);
      return;
    }
    if (message.type !== "dispatch") return;
    if (!slot || message.requestId !== slot.requestId || slot.dispatchSeen) {
      this.deny(message.id, message.requestId);
      return;
    }
    slot.dispatchSeen = true;
    slot.dispatchedId = message.id;
    try {
      this.assertLive(slot);
      const wire = this.wire(message.wire, slot.chat);
      if (slot.mode === "prepare") {
        slot.prepared = wire;
        // 9Router selects its response transformer from the request's stream flag.
        // A JSON fixture for a streaming request becomes invalid SSE plus [DONE].
        const prepared = slot.chat.stream
          ? { headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify({ model: wire.model, choices: [{ index: 0, delta: { role: "assistant", content: "prepared-only" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` }
          : { headers: { "content-type": "application/json" }, body: JSON.stringify({ model: wire.model, choices: [{ message: { role: "assistant", content: "prepared-only" }, finish_reason: "stop" }] }) };
        await this.reply(slot, { status: 200, ...prepared });
        return;
      }
      const effect = slot.effect;
      if (!effect || canonicalGatewayWirePayload(wire) !== canonicalGatewayWirePayload(slot.approved)) throw failure();
      const key = JSON.stringify([effect.principalId, effect.projectId, effect.runId, effect.attemptId]);
      if (this.consumed.has(key) || this.consumed.size >= 10_000) throw failure();
      await this.admitted(slot, effect);
      this.assertLive(slot);
      this.consumed.add(key);
      await this.validateDispatchAuthority(slot, wire);
      if (this.accountFunding) {
        const admission = this.accountFunding(slot.chat, wire, effect, slot.controller.signal).catch(error => {
          slot.refusal = refusalCode(error); throw error;
        }).then(async reservation => {
          // An admission can complete after abort. It never authorizes late fetch.
          if (slot.released || slot.controller.signal.aborted || this.slot !== slot) {
            await reservation?.compensate(); throw failure();
          }
          slot.funding = reservation;
        });
        await untilAbort(admission, slot.controller.signal);
        this.assertLive(slot);
      }
      if (this.options.beforeDispatch) {
        await untilAbort(this.options.beforeDispatch(slot.chat, wire, effect, slot.controller.signal).catch(error => {
          slot.refusal = refusalCode(error); throw error;
        }), slot.controller.signal);
        this.assertLive(slot);
      }
      const secret = await untilAbort(this.options.resolveCredential(), slot.controller.signal);
      this.assertLive(slot);
      if (typeof secret !== "string" || !secret || secret.length > 16_384 || /[\r\n\0]/.test(secret)) throw failure();
      slot.secret = secret;
      // Read again after credential resolution; cancellation or settlement may have occurred.
      await this.admitted(slot, effect);
      this.assertLive(slot);
      try { await slot.funding?.validate?.(); }
      catch (error) { slot.refusal = refusalCode(error); throw error; }
      this.assertLive(slot);
      // Last asynchronous authority check: declaration withdrawal while waiting for
      // quota, credentials or funding cannot authorize a late provider dispatch.
      await this.validateDispatchAuthority(slot, wire);
      // Once the transport is invoked, even a synchronous failure is ambiguous.
      slot.providerDispatched = true;
      const providerRequest = (this.options.fetchImpl ?? fetch)(wire.url, {
        method: wire.method, body: wire.body, headers: { ...wire.headers, authorization: `Bearer ${secret}` },
        redirect: "error", signal: slot.controller.signal,
      });
      void providerRequest.then(response => { if (slot.controller.signal.aborted) cancelStream(response.body); }, () => undefined);
      const response = await untilAbort(providerRequest, slot.controller.signal);
      if (isSse(response)) {
        if (!slot.chat.stream || !response.ok) { cancelStream(response.body); throw failure(); }
        slot.stream = { reader: this.sse(response, effect.limits.maxOutputBytes, slot, false).getReader(), reading: false };
        await this.reply(slot, { status: response.status, headers: { "content-type": "text/event-stream" } }, "stream-start");
        return;
      }
      const result = await this.json(response, effect.limits.maxOutputBytes, slot);
      if (response.ok) {
        const usage = fundingUsage(JSON.parse(result.body).usage);
        if (usage) await slot.funding?.settle(usage.input, usage.output);
      }
      await this.reply(slot, { ...result, headers: { "content-type": "application/json" } });
    } catch {
      await this.compensateUnsent(slot).catch(() => undefined);
      this.deny(message.id, message.requestId);
      // An old async completion must never abort the next invocation.
      if (this.slot === slot) slot.controller.abort(failure());
    }
  }

  private async pull(slot: Slot): Promise<void> {
    const stream = slot.stream;
    if (!stream) return;
    if (stream.reading) { stream.pendingPull = true; return; }
    stream.reading = true;
    try {
      this.assertLive(slot);
      const item = await untilAbort(stream.reader.read(), slot.controller.signal);
      this.assertLive(slot);
      if (item.done) {
        slot.stream = undefined;
        await this.reply(slot, {}, "stream-end");
      } else await this.reply(slot, { data: Buffer.from(item.value).toString("base64") }, "stream-chunk");
    } catch {
      try { await this.reply(slot, {}, "stream-error"); } catch { /* Closed or cancelled channel. */ }
      if (this.slot === slot) slot.controller.abort(failure());
    } finally {
      stream.reading = false;
      if (stream.pendingPull && slot.stream === stream && !slot.controller.signal.aborted) {
        stream.pendingPull = false;
        void this.pull(slot);
      }
    }
  }

  /** Both provider→child and child→caller cross this bounded, decoded SSE boundary. */
  private sse(response: Response, limit: number, slot: Slot, releaseAtEnd: boolean): ReadableStream<Uint8Array> {
    this.assertLive(slot);
    if (!response.body) throw failure();
    const reader = response.body.getReader();
    const signal = slot.controller.signal;
    const maxBytes = Math.min(limit, MAX_INFERENCE_REQUEST_BYTES);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const encoder = new TextEncoder();
    const pending: Uint8Array[] = [];
    const secret = slot.secret;
    const toolCalls = new Map<number, {id:string;type:'function';function:{name:string;arguments:string}}>();
    let responseId: string | undefined, responseCreated: number | undefined;
    let bytes = 0, outputBytes = 0, tail = "", done = false, finished = false, terminal = false;
    let fundingObserved: { input: number; output: number } | undefined;
    let fundingUsageConflict = false;
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const emit = (value: unknown) => {
      const data = encoder.encode(`data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`);
      outputBytes += data.byteLength;
      if (outputBytes > maxBytes) throw failure();
      pending.push(data);
    };
    const parser = createParser({ onError: () => { throw failure(); }, onEvent: event => {
      // The pinned 9Router passthrough can append a second terminal sentinel on flush.
      // Normalize that sentinel only; data after the terminal boundary still fails closed.
      if (done) { if (event.data === "[DONE]") return; throw failure(); }
      if (event.data === "[DONE]") {
        if (!finished || tail) throw failure();
        done = true; emit("[DONE]"); return;
      }
      const value: unknown = JSON.parse(event.data);
      if (!isDataRecord(value) || !Array.isArray(value.choices) || value.choices.length > 1 || containsSecret(value, secret)) throw failure();
      // Preserve validated provider identity for persisted protocol projections.
      // Missing metadata stays missing; neither boundary invents identity or time.
      const result: Record<string, unknown> = { model: this.options.providerModel, choices: [] };
      if (value.id !== undefined) {
        if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id) ||
            responseId !== undefined && value.id !== responseId) throw failure();
        responseId = value.id;
        result.id = value.id;
      }
      if (value.created !== undefined) {
        if (!Number.isSafeInteger(value.created) || (value.created as number) < 1 ||
            responseCreated !== undefined && value.created !== responseCreated) throw failure();
        responseCreated = value.created as number;
        result.created = value.created;
      }
      if (secret && this.options.providerModel.includes(secret)) throw failure();
      if (value.choices.length) {
        const choice = value.choices[0];
        if (!isDataRecord(choice) || choice.index !== 0 || !isDataRecord(choice.delta) ||
            Object.keys(choice.delta).some(key => !["role", "content", "tool_calls"].includes(key)) ||
            ![undefined, "assistant"].includes(choice.delta.role as string | undefined) ||
            ![undefined, null, "stop", "length", "content_filter", "tool_calls"].includes(choice.finish_reason as string | null | undefined)) throw failure();
        if (choice.delta.tool_calls !== undefined) {
          if (finished || !slot.chat.tools || slot.chat.tool_choice === 'none' || !Array.isArray(choice.delta.tool_calls) ||
              choice.delta.tool_calls.length > GATEWAY_TOOL_MAX_COUNT) throw failure();
          for (const fragment of choice.delta.tool_calls) {
            if (!isDataRecord(fragment) || !Number.isSafeInteger(fragment.index) || (fragment.index as number) < 0 ||
                (fragment.index as number) >= GATEWAY_TOOL_MAX_COUNT || Object.keys(fragment).some(k=>!['index','id','type','function'].includes(k))) throw failure();
            const index=fragment.index as number;
            const call=toolCalls.get(index) ?? {id:'',type:'function' as const,function:{name:'',arguments:''}};
            if (fragment.type !== undefined && fragment.type !== 'function') throw failure();
            if (fragment.id !== undefined) {
              if (typeof fragment.id !== 'string' || call.id && call.id !== fragment.id) throw failure();
              call.id=fragment.id;
            }
            if (fragment.function !== undefined) {
              if (!isDataRecord(fragment.function) || Object.keys(fragment.function).some(k=>!['name','arguments'].includes(k))) throw failure();
              for (const key of ['name','arguments'] as const) if (fragment.function[key] !== undefined) {
                if (typeof fragment.function[key] !== 'string') throw failure();
                call.function[key]+=fragment.function[key];
              }
            }
            if (containsSecret(call,secret)) throw failure();
            toolCalls.set(index,call);
          }
        }
        const content = choice.delta.content;
        if (content !== undefined && content !== null && typeof content !== "string" || finished && (content || choice.finish_reason)) throw failure();
        let text = tail + (typeof content === "string" ? content : "");
        if (secret && text.includes(secret)) throw failure();
        const ending = choice.finish_reason !== undefined && choice.finish_reason !== null;
        if (ending && slot.mode === 'execute' && requiresTool(slot.chat) && !toolCalls.size) throw failure();
        tail = "";
        if (secret && !ending) {
          // Retain precisely the suffix that could become the credential in a later delta.
          for (let size = Math.min(secret.length - 1, text.length); size > 0; size--) {
            if (text.endsWith(secret.slice(0, size))) { tail = text.slice(-size); text = text.slice(0, -size); break; }
          }
        }
        if (ending) finished = true;
        const delta: Record<string, unknown> = {};
        if (ending && (toolCalls.size || choice.finish_reason === 'tool_calls')) {
          if (choice.finish_reason !== 'tool_calls') throw failure();
          const ordered=[...toolCalls.entries()].sort(([a],[b])=>a-b);
          if (ordered.some(([index],position)=>index!==position)) throw failure();
          const proposal=toolProposal(slot.chat,null,ordered.map(([,call])=>call),secret);
          delta.tool_calls=proposal.toolCalls.map((call,index)=>({...call,index}));
        }
        if (choice.delta.role === "assistant") delta.role = "assistant";
        if (text) delta.content = text;
        result.choices = [{ index: 0, delta, finish_reason: choice.finish_reason ?? null }];
      }
      if (value.usage !== undefined && value.usage !== null) {
        result.usage = safeUsage(value.usage);
        const usage = fundingUsage(value.usage);
        if (!usage || fundingObserved && (usage.input !== fundingObserved.input || usage.output !== fundingObserved.output)) fundingUsageConflict = true;
        if (usage) fundingObserved = usage;
      }
      emit(result);
    } });
    const clean = () => {
      if (terminal) return false;
      terminal = true; signal.removeEventListener("abort", aborted);
      void reader.cancel().catch(() => undefined);
      if (releaseAtEnd) this.release(slot);
      return true;
    };
    const aborted = () => { if (clean()) output.error(failure()); };
    return new ReadableStream<Uint8Array>({
      start: controller => { output = controller; signal.addEventListener("abort", aborted, { once: true }); if (signal.aborted) aborted(); },
      pull: async controller => {
        if (terminal) return;
        try {
          this.assertLive(slot);
          while (!pending.length) {
            const item = await untilAbort(reader.read(), signal);
            this.assertLive(slot);
            if (item.done) {
              parser.feed(decoder.decode());
              if (!done) throw failure();
              // Only provider→child settles. The child's projection cannot claim
              // new usage or settle the same account again at the second boundary.
              if (!releaseAtEnd && slot.mode === 'execute' && !fundingUsageConflict && fundingObserved) {
                await slot.funding?.settle(fundingObserved.input, fundingObserved.output);
                this.assertLive(slot);
              }
              if (clean()) controller.close();
              return;
            }
            bytes += item.value.byteLength;
            if (bytes > maxBytes) throw failure();
            parser.feed(decoder.decode(item.value, { stream: true }));
          }
          controller.enqueue(pending.shift()!);
        } catch {
          if (clean()) controller.error(failure());
          if (this.slot === slot) slot.controller.abort(failure());
        }
      },
      cancel: () => { clean(); if (this.slot === slot) slot.controller.abort(failure()); },
    }, { highWaterMark: 0 });
  }

  private async admitted(slot: Slot, effect: EffectRequest): Promise<void> {
    this.assertLive(slot);
    const journal = await untilAbort(this.options.store.readRun(effect.principalId, effect.projectId, effect.runId), slot.controller.signal);
    this.assertLive(slot);
    const matches = journal?.receipts.filter(receipt => receipt.attemptId === effect.attemptId);
    const receipt = matches?.[0];
    if (!journal || journal.run.id !== effect.runId || journal.run.projectId !== effect.projectId ||
        journal.run.principalId !== effect.principalId || journal.run.status !== "running" || matches?.length !== 1 ||
        receipt?.status !== "dispatched" || receipt.projectId !== effect.projectId || receipt.runId !== effect.runId ||
        receipt.stepId !== effect.stepId || receipt.capabilityId !== effect.capability.id || receipt.capabilityVersion !== effect.capability.version) throw failure();
  }

  private async json(response: Response, limit: number, slot: Slot): Promise<{ status: number; body: string }> {
    this.assertLive(slot);
    const maxBytes = Math.min(limit, MAX_INFERENCE_REQUEST_BYTES);
    // The signal-aware pipe cancels a blocked reader even for an injected transport.
    const input = new Response(response.body?.pipeThrough(new TransformStream(), { signal: slot.controller.signal }), { status: response.status, headers: response.headers });
    const result = await untilAbort(readBoundedJson(input, maxBytes, Math.max(1, Math.ceil(slot.deadline - Date.now()))), slot.controller.signal);
    this.assertLive(slot);
    if (!result.ok || !isDataRecord(result.value)) { cancelStream(input.body); throw failure(); }
    // Proposals are data only: preserve approved tool requests, never execute them.
    if (response.ok && Array.isArray(result.value.choices)) {
      for (const choice of result.value.choices) {
        if (!isDataRecord(choice)) throw failure();
        const message = choice.message;
        if (choice.finish_reason === 'function_call' || isDataRecord(message) && Object.hasOwn(message,'function_call')) throw failure();
        if (choice.finish_reason === 'tool_calls' || isDataRecord(message) && Object.hasOwn(message,'tool_calls')) {
          if (result.value.choices.length !== 1 || choice.finish_reason !== 'tool_calls' || !isDataRecord(message)) throw failure();
          toolProposal(slot.chat,message.content ?? null,message.tool_calls,slot.secret);
        } else if (slot.mode === 'execute' && requiresTool(slot.chat)) throw failure();
      }
    }
    const body = JSON.stringify(result.value);
    if (Buffer.byteLength(body) > maxBytes || containsSecret(result.value,slot.secret)) throw failure();
    return { status: response.status, body };
  }

  private reply(slot: Slot, result: Record<string, unknown>, type = "result"): Promise<void> {
    this.assertLive(slot);
    slot.responded = true;
    return new Promise((resolve, reject) => {
      try { this.options.child.send({ type, id: slot.dispatchedId, requestId: slot.requestId, ...result }, error => error ? reject(failure()) : resolve()); }
      catch { reject(failure()); }
    });
  }

  private deny(id: string, requestId: string): void {
    if (!this.options.child.connected) return;
    try { this.options.child.send({ type: "result", id, requestId, error: true }, () => undefined); } catch { /* closed channel */ }
  }
}

async function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); throw failure(); }
  let abort!: () => void;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(failure());
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

function isSse(response: Response): boolean {
  return response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

/** Only exact complete token pairs can release a monetary reservation. */
function fundingUsage(value: unknown): { input: number; output: number } | undefined {
  if (!isDataRecord(value)) return;
  const input = value.prompt_tokens, output = value.completion_tokens, total = value.total_tokens;
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isSafeInteger(input) || !Number.isSafeInteger(output)
    || input < 0 || output < 0 || !Number.isSafeInteger(input + output)) return;
  if (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total !== input + output)) return;
  return { input, output };
}

function toolProposal(chat:GatewayChatRequest,content:unknown,calls:unknown,secret:string|undefined) {
  if (!chat.tools || chat.tool_choice === 'none') throw failure();
  const proposal=parseGatewayToolProposal({schemaVersion:1,content,toolCalls:calls},chat.tools);
  if (containsSecret(proposal,secret) || chat.parallel_tool_calls === false && proposal.toolCalls.length > 1) throw failure();
  if (proposal.toolCalls.some(call=>containsSecret(JSON.parse(call.function.arguments),secret))) throw failure();
  const choice=chat.tool_choice;
  if (typeof choice === 'object' && proposal.toolCalls.some(call=>call.function.name!==choice.function.name)) throw failure();
  return proposal;
}

function requiresTool(chat:GatewayChatRequest):boolean {
  return chat.tool_choice === 'required' || typeof chat.tool_choice === 'object';
}

function containsSecret(value: unknown, secret: string | undefined): boolean {
  if (!secret) return false;
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && item.includes(secret)) return true;
    if (item && typeof item === "object") pending.push(...Object.values(item));
  }
  return false;
}

function safeUsage(value: unknown): Record<string, unknown> {
  if (!isDataRecord(value)) throw failure();
  const result: Record<string, unknown> = {};
  for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    const amount = value[field];
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw failure();
    result[field] = amount;
  }
  if (value.prompt_tokens_details !== undefined) {
    if (!isDataRecord(value.prompt_tokens_details)) throw failure();
    const cached = value.prompt_tokens_details.cached_tokens;
    if (cached !== undefined) {
      if (typeof cached !== "number" || !Number.isSafeInteger(cached) || cached < 0) throw failure();
      result.prompt_tokens_details = { cached_tokens: cached };
    }
  }
  return result;
}

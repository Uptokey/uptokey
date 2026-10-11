/** Realtime voice consumer of the existing W5/session owner. No provider SDK,
 * credentials, recording files, reconnect replay, or parallel conversation store.
 * Native capture/playback is injected in tests and starts only after authorization.
 */
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { parseVoiceSession, parseVoiceEvent, VOICE_SESSION_MAX_BUFFERED_AUDIO_MS, type VoiceSession, type VoiceEvent } from "@uptokey/sync-contract/voice-session";
import { readBoundedJson } from "@uptokey/sync-contract/limits";
import { AudioCapture, playPcm } from "./audio-io.ts";
import type { TuiClient } from "./client.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

type VoiceClient = Pick<TuiClient, "fetchRaw">;
export interface TuiVoiceProfile {
  available: boolean; configured?: boolean; profileRevision: number; model: string; voices: readonly string[];
  budgetRequired?: boolean; budgetReady?: boolean; budgetReason?: string;
  budgetLimits?: { maxPostInstructionsTokens: number; maxOutputTokens: number };
}
export interface VoiceCapture extends EventEmitter { start(device?: string): Promise<void>; stop(): Promise<Buffer>; cancel(): Promise<void> }
export interface VoiceStartResult { sessionId: string; runId?: string }
export interface RealtimeVoiceOptions {
  client: VoiceClient; projectId: string;
  /** Prepare canonical voice-plans, display W5 review, approveAndRun, then read its output artifact. */
  authorize: (session: VoiceSession, signal: AbortSignal) => Promise<VoiceStartResult>;
  capture?: VoiceCapture;
  playback?: (pcm: Uint8Array, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
}
export interface VoiceTranscriptLine { speaker: "user" | "assistant"; text: string; final: boolean }
export interface RealtimeVoiceSnapshot {
  state: "idle" | "authorizing" | "connecting" | "active" | "stopping" | "closed" | "failed";
  sessionId?: string; runId?: string; listening: boolean; level: number; durationMs: number;
  inputQueuedMs: number; outputQueuedMs: number; transcript: VoiceTranscriptLine[]; cursor: number; error?: string; reason?: string;
}
interface LivePayload { sequence: number; type: "text" | "audio"; speaker: "user" | "assistant"; text?: string; audioBase64?: string; itemId?: string; final?: boolean }
interface LivePage { sessionId: string; status: string; reason?: string | null; done: boolean; events: VoiceEvent[]; payloads: LivePayload[]; nextSequence: number }
const MAX_QUEUE_BYTES = VOICE_SESSION_MAX_BUFFERED_AUDIO_MS * 48;
const FRAME_BYTES = 24_000;
const stableId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id);

async function json<T>(client: VoiceClient, path: string, init: RequestInit = {}): Promise<T> {
  const response = await client.fetchRaw(path, init);
  const body = await readBoundedJson(response, 1024 * 1024, 10_000);
  if (!body.ok) throw new Error("voice_response_invalid");
  if (!response.ok) {
    const code = body.value && typeof body.value === "object" ? (body.value as { error?: unknown; code?: unknown }).code ?? (body.value as { error?: unknown }).error : undefined;
    throw new Error(typeof code === "string" && /^[a-z][a-z0-9_:-]{0,100}$/.test(code) ? code : `voice_http_${response.status}`);
  }
  return body.value as T;
}
export function loadVoiceProfile(client: VoiceClient, signal?: AbortSignal): Promise<TuiVoiceProfile> { return json(client, "/v1/workspace/voice", { signal }); }
export function voiceSessionFromProfile(profile: TuiVoiceProfile, options: { maxDurationMs?: number; voice?: string; instructions?: string } = {}): VoiceSession {
  if (!profile.available || profile.configured === false) throw new Error("voice_unavailable");
  if (profile.budgetRequired && !profile.budgetReady) throw new Error(profile.budgetReason ?? "budget_cost_unknown");
  const voice = options.voice ?? profile.voices[0];
  if (!voice || !profile.voices.includes(voice)) throw new Error("voice_profile_voice_missing");
  return parseVoiceSession({ profileRevision: profile.profileRevision, transport: "websocket", codec: "pcm16", sampleRate: 24000, maxDurationMs: options.maxDurationMs ?? 120000, allowedTools: [], turnPolicy: "push_to_talk", modalities: ["audio"], voice, inputAudioFormat: "pcm16", outputAudioFormat: "pcm16", interruptResponse: true, toolChoice: "none", ...(options.instructions ? { instructions: options.instructions } : {}), ...(profile.budgetLimits ? { maxResponseOutputTokens: profile.budgetLimits.maxOutputTokens } : {}) });
}

export class TuiRealtimeVoice extends EventEmitter {
  private readonly options: RealtimeVoiceOptions;
  private readonly capture: VoiceCapture;
  private readonly playback: (pcm: Uint8Array, signal?: AbortSignal) => Promise<void>;
  private readonly lifetime = new AbortController();
  private current: RealtimeVoiceSnapshot = { state: "idle", listening: false, level: 0, durationMs: 0, inputQueuedMs: 0, outputQueuedMs: 0, transcript: [], cursor: 0 };
  private input = Buffer.alloc(0);
  private inputInFlight = 0;
  private activeInput: Buffer | null = null;
  private sending: Promise<void> | null = null;
  private captureStarting = false;
  private committing = false;
  private output: Array<{ bytes: Buffer; itemId?: string }> = [];
  private outputBytes = 0;
  private playing: Promise<void> | null = null;
  private playbackAbort = new AbortController();
  private playbackGeneration = 0;
  private played = new Map<string, number>();
  private currentPlayback: { itemId?: string; startedAt: number; durationMs: number } | null = null;
  private activeOutput: Buffer | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private onPcm = (chunk: Buffer) => { if (this.current.listening && !this.lifetime.signal.aborted) this.queueInput(chunk); };
  private onLevel = (level: { rms: number; durationMs: number }) => { if (!this.current.listening) return; this.current.level = Math.max(0, Math.min(1, level.rms)); this.current.durationMs = level.durationMs; this.changed(); };
  private onCaptureFailure = (error: Error) => { void this.fail(error); };
  private onCaptureLimit = () => { if(this.current.listening&&!this.committing&&!this.captureStarting&&!this.lifetime.signal.aborted)void this.commit().catch(error=>this.fail(error)); };
  constructor(options: RealtimeVoiceOptions) {
    super();
    if (!stableId(options.projectId)) throw new Error("voice_project_invalid");
    this.options = options; this.capture = options.capture ?? new AudioCapture(); this.playback = options.playback ?? playPcm;
    this.capture.on("pcm", this.onPcm); this.capture.on("level", this.onLevel); this.capture.on("failure", this.onCaptureFailure); this.capture.on("limit",this.onCaptureLimit);
  }
  get snapshot(): RealtimeVoiceSnapshot { return structuredClone(this.current); }
  private changed(): void { this.current.inputQueuedMs = Math.ceil((this.input.length + this.inputInFlight) / 48); this.current.outputQueuedMs = Math.ceil(this.outputBytes / 48); this.emit("change", this.snapshot); }
  private path(action: string): string { if (!this.current.sessionId) throw new Error("voice_session_missing"); return `/v1/workspace/projects/${this.options.projectId}/voice-sessions/${this.current.sessionId}/${action}`; }
  private post(action: string, body: object = {}, signal: AbortSignal = this.lifetime.signal): Promise<unknown> { return json(this.options.client, this.path(action), { method: "POST", body: JSON.stringify(body), signal }); }
  async start(input: VoiceSession, options: { device?: string } = {}): Promise<void> {
    if (this.current.state !== "idle") throw new Error("voice_already_started");
    const session = parseVoiceSession(input);
    if (session.codec !== "pcm16" || session.sampleRate !== 24000 || session.transport !== "websocket" || session.turnPolicy !== "push_to_talk" || session.allowedTools.length) throw new Error("voice_session_unsupported");
    this.current.state = "authorizing"; this.changed();
    try {
      const result = await this.options.authorize(session, this.lifetime.signal);
      if (!stableId(result.sessionId) || (result.runId !== undefined && !stableId(result.runId))) throw new Error("voice_start_result_invalid");
      this.current.sessionId = result.sessionId; this.current.runId = result.runId;
      if (this.lifetime.signal.aborted) { await this.post("stop", {}, AbortSignal.timeout(3000)).catch(() => undefined); throw new Error("voice_cancelled"); }
      this.current.state = "connecting"; this.changed();
      // Confirm the issued session is still live before opening the microphone.
      await this.poll();
      this.lifetime.signal.throwIfAborted();
      if (["closed", "failed"].includes(this.current.state)) throw new Error(this.current.reason ?? "voice_session_closed");
      this.current.state = "active"; this.changed();
      this.deadline = setTimeout(() => { void this.stop("max_duration"); }, session.maxDurationMs);
      await this.listen(options);
      void this.pollLoop();
    } catch (error) { if (!this.lifetime.signal.aborted) await this.fail(error); throw error; }
  }
  /** A new explicit push-to-talk turn. Does not commit or resend a previous turn. */
  async listen(options: { device?: string } = {}): Promise<void> {
    if (this.current.state !== "active" || this.lifetime.signal.aborted) throw new Error("voice_not_active");
    if (this.current.listening || this.captureStarting || this.committing) throw new Error("voice_capture_active");
    this.captureStarting = true;
    try {
      this.current.listening = true; this.current.level = 0; this.current.durationMs = 0; this.changed();
      await this.capture.start(options.device);
      if (this.lifetime.signal.aborted || this.current.state !== "active") { await this.capture.cancel(); throw new Error("voice_cancelled"); }
    } catch (error) { this.current.listening = false; if (!this.lifetime.signal.aborted) await this.fail(error); throw error; }
    finally { this.captureStarting = false; }
  }
  private queueInput(chunk: Buffer): void {
    if (!chunk.length) return;
    if (this.input.length + this.inputInFlight + chunk.length > MAX_QUEUE_BYTES) { void this.fail(new Error("voice_input_backpressure")); return; }
    const previous = this.input; this.input = Buffer.concat([previous, chunk]); previous.fill(0); this.changed();
    void this.pumpInput().catch((error) => this.fail(error));
  }
  private pumpInput(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      while (this.input.length >= 48 && !this.lifetime.signal.aborted) {
        const length = Math.min(FRAME_BYTES, this.input.length - this.input.length % 48);
        const frame = Buffer.from(this.input.subarray(0, length)), rest = Buffer.from(this.input.subarray(length)); this.input.fill(0); this.input = rest;
        this.inputInFlight = length;
        this.activeInput = frame;
        try { await this.post("audio", { audioBase64: frame.toString("base64"), audioMs: length / 48 }); }
        finally { frame.fill(0); this.activeInput = null; this.inputInFlight = 0; this.changed(); }
      }
    })().finally(() => { this.sending = null; });
    return this.sending;
  }
  async commit(): Promise<void> {
    if (this.current.state !== "active" || !this.current.listening || this.captureStarting || this.committing) throw new Error("voice_not_listening");
    this.committing = true;
    try {
      // Capture may emit its final PCM before stop settles: keep listener enabled.
      const captured = await this.capture.stop(); captured.fill(0); this.current.listening = false; this.current.level = 0;
      if (this.sending) await this.sending;
      if (this.input.length % 2) throw new Error("voice_pcm_invalid");
      if (this.input.length && this.input.length < 48) { const padded = Buffer.alloc(48); this.input.copy(padded); this.input.fill(0); this.input = padded; }
      await this.pumpInput(); this.lifetime.signal.throwIfAborted();
      await this.post("commit"); this.changed();
    } catch (error) { if (!this.lifetime.signal.aborted) await this.fail(error); throw error; }
    finally { this.committing = false; }
  }
  private async pollLoop(): Promise<void> {
    try { while (!this.lifetime.signal.aborted && this.current.state === "active") { await sleep(Math.max(50, Math.min(1000, this.options.pollIntervalMs ?? 180)), undefined, { signal: this.lifetime.signal }); await this.poll(); } }
    catch (error) { if (!this.lifetime.signal.aborted) await this.fail(error); }
  }
  private async poll(): Promise<void> {
    const after = this.current.cursor;
    const page = await json<LivePage>(this.options.client, `${this.path("live")}?after=${after}`, { signal: this.lifetime.signal });
    if (this.lifetime.signal.aborted) return;
    if (page.sessionId !== this.current.sessionId || !Number.isSafeInteger(page.nextSequence) || page.nextSequence < after || !Array.isArray(page.events) || !Array.isArray(page.payloads) || page.payloads.length > 128 || !["ready", "active", "closed", "failed", "expired"].includes(page.status)) throw new Error("voice_live_invalid");
    let interruptedAt = -1;
    for (const raw of page.events) {
      const event = parseVoiceEvent(raw);
      if (event.sessionId !== this.current.sessionId || (this.current.runId && event.runId !== this.current.runId) || event.sequence < after || event.sequence >= page.nextSequence) throw new Error("voice_event_mismatch");
      if (event.type === "turn_interrupted" || event.type === "speech_started") interruptedAt = Math.max(interruptedAt, event.sequence);
    }
    if (interruptedAt >= 0) this.clearPlayback();
    let lastSequence = after - 1;
    for (const payload of page.payloads) {
      if (!Number.isSafeInteger(payload.sequence) || payload.sequence < after || payload.sequence <= lastSequence || payload.sequence >= page.nextSequence || !["user", "assistant"].includes(payload.speaker)) throw new Error("voice_payload_invalid");
      lastSequence = payload.sequence;
      if (payload.type === "text") this.appendText(payload);
      else if (payload.type === "audio" && payload.sequence > interruptedAt) this.queuePlayback(payload);
      else if (payload.type !== "audio") throw new Error("voice_payload_invalid");
    }
    this.current.cursor = page.nextSequence; this.changed();
    if (page.done || ["closed", "failed", "expired"].includes(page.status)) {
      if (page.status === "failed") this.current.error = page.reason ?? "voice_session_failed";
      await this.closeLocally(page.status === "failed" ? "failed" : "closed", page.reason ?? page.status);
    }
  }
  private appendText(payload: LivePayload): void {
    if (typeof payload.text !== "string" || payload.text.length > 16000) throw new Error("voice_payload_invalid");
    const text = sanitizeForDisplay(payload.text), previous = this.current.transcript.at(-1);
    if (previous && previous.speaker === payload.speaker && !previous.final) { previous.text = (payload.final ? text : previous.text + text).slice(-16000); previous.final = payload.final === true; }
    else this.current.transcript.push({ speaker: payload.speaker, text, final: payload.final === true });
    this.current.transcript = this.current.transcript.slice(-40);
  }
  private queuePlayback(payload: LivePayload): void {
    if (typeof payload.audioBase64 !== "string" || payload.audioBase64.length > 128000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.audioBase64) || (payload.itemId !== undefined && !stableId(payload.itemId))) throw new Error("voice_audio_invalid");
    const bytes = Buffer.from(payload.audioBase64, "base64");
    if (!bytes.length || bytes.length % 2) throw new Error("voice_audio_invalid");
    if (this.outputBytes + bytes.length > MAX_QUEUE_BYTES) { bytes.fill(0); throw new Error("voice_output_backpressure"); }
    this.output.push({ bytes, itemId: payload.itemId }); this.outputBytes += bytes.length;
    this.startPlayback();
  }
  private startPlayback(): void {
    if (this.playing || !this.output.length || this.lifetime.signal.aborted) return;
    const generation = this.playbackGeneration;
    this.playing = this.pumpPlayback().catch((error) => { if (!this.lifetime.signal.aborted && generation === this.playbackGeneration) return this.fail(error); }).finally(() => { this.playing = null; this.startPlayback(); });
  }
  private async pumpPlayback(): Promise<void> {
    const generation = this.playbackGeneration, signal = this.playbackAbort.signal;
    while (this.output.length && !this.lifetime.signal.aborted && !signal.aborted && generation === this.playbackGeneration) {
      const item = this.output.shift()!; this.currentPlayback = { itemId: item.itemId, startedAt: Date.now(), durationMs: item.bytes.length / 48 };
      this.activeOutput = item.bytes;
      try { await this.playback(item.bytes, signal); if (item.itemId && generation === this.playbackGeneration) { this.played.set(item.itemId, (this.played.get(item.itemId) ?? 0) + item.bytes.length / 48); while (this.played.size > 16) this.played.delete(this.played.keys().next().value!); } }
      finally { if (generation === this.playbackGeneration) this.outputBytes = Math.max(0, this.outputBytes - item.bytes.length); item.bytes.fill(0); this.activeOutput = null; this.currentPlayback = null; this.changed(); }
    }
  }
  private clearPlayback(): void {
    this.playbackGeneration++; this.playbackAbort.abort(new Error("voice_playback_interrupted")); this.playbackAbort = new AbortController();
    this.activeOutput?.fill(0);
    for (const item of this.output) item.bytes.fill(0); this.output = []; this.outputBytes = 0; this.changed();
  }
  async interrupt(): Promise<void> {
    if (this.current.state !== "active") throw new Error("voice_not_active");
    const playing = this.currentPlayback;
    const playback = playing?.itemId ? { itemId: playing.itemId, audioEndMs: Math.floor((this.played.get(playing.itemId) ?? 0) + Math.min(playing.durationMs, Math.max(0, Date.now() - playing.startedAt))) } : {};
    this.clearPlayback();
    try { await this.post("interrupt", playback); } catch (error) { await this.fail(error); throw error; }
  }
  private async closeLocally(state: "closed" | "failed", reason: string): Promise<void> {
    this.current.state = state; this.current.reason = reason; this.current.listening = false; this.current.level = 0;
    this.lifetime.abort(new Error("voice_closed")); if (this.deadline) clearTimeout(this.deadline); this.deadline = null;
    this.input.fill(0); this.input = Buffer.alloc(0); this.activeInput?.fill(0); this.inputInFlight = 0; this.clearPlayback(); this.played.clear();
    await this.capture.cancel().catch(() => undefined); this.changed();
  }
  private async fail(error: unknown): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    this.current.error = error instanceof Error ? error.message : "voice_failed";
    await this.closeLocally("failed", this.current.error);
    if (this.current.sessionId) await this.post("stop", {}, AbortSignal.timeout(3000)).catch(() => undefined);
  }
  stop(reason = "client_stop"): Promise<void> {
    if (this.stopping) return this.stopping;
    this.current.state = "stopping"; this.changed();
    this.stopping = (async () => {
      await this.closeLocally("closed", reason);
      if (this.current.sessionId) {
        try { await this.post("stop", {}, AbortSignal.timeout(3000)); }
        catch (error) { this.current.error = error instanceof Error ? error.message : "voice_stop_unconfirmed"; this.changed(); }
      }
    })();
    return this.stopping;
  }
  async dispose(): Promise<void> { await this.stop(); this.capture.off("pcm", this.onPcm); this.capture.off("level", this.onLevel); this.capture.off("failure", this.onCaptureFailure); this.capture.off("limit",this.onCaptureLimit); this.removeAllListeners(); }
}

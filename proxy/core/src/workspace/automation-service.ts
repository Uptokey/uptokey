/**
 * E2-13 facade — wires mini-chat, presets, scheduler, channels.
 * Shared runtime/http/store remain coordinator-owned; this is the exclusive package surface.
 */

import { AutomationConversationStore, MiniChatPipeline, type PipelineHooks } from "./automation-conversation.ts";
import { AutomationPresetStore, type PresetStep, type PresetEdge } from "./automation-presets.ts";
import { AutomationScheduler } from "./automation-scheduler.ts";
import { ChannelOutbox, miniChatAuthorizesChannelSend, type ChannelKind, type ChannelMessage } from "./automation-channels.ts";
import { AutomationChainStore, AutomationChainExecutor, type ChainEffectDispatcher, type ChainExecutorOptions, type ChainRun } from "./automation-chain.ts";
import { type Clock, SystemClock, AutomationError, isId } from "./automation-types.ts";
import { AutomationPersistence, type AutomationPersistedState } from "./automation-persistence.ts";
import {AutomationScheduleGrants} from './automation-schedule-grants.ts';

export type AutomationServiceOptions = {
  clock?: Clock;
  hooks?: Partial<PipelineHooks>;
  /** Durable SQLite root (E2-13 correção); ausente → in-memory (somente testes unitários). */
  root?: string;
  /** Scheduling prepares governed plans and may use an existing bounded W5 grant. */
  prepareScheduled?: (occurrence: import('./automation-scheduler.ts').ScheduleOccurrence, schedule: import('./automation-scheduler.ts').AutomationSchedule, preset: import('./automation-presets.ts').AutomationPreset) => Promise<import('./automation-scheduler.ts').ScheduledPreparationResult>;
  /** Explicit fixtures only; production may never report a synthetic delivery. */
  allowSyntheticChannels?: boolean;
  delivery?: import('./automation-delivery.ts').WorkspaceAutomationDelivery;
  prepareChannel?: (principal:string,projectId:string,input:unknown)=>ReturnType<import('./runtime.ts').WorkspaceRuntime['viewPlan']>;
  prepareScheduleGrant?: (principal:string,projectId:string,input:unknown)=>ReturnType<import('./runtime.ts').WorkspaceRuntime['viewPlan']>;
  /** Durable short-chain effects; absence keeps chains unavailable (fail closed). */
  chainEffects?: ChainEffectDispatcher;
  chainExecutor?: Partial<Pick<ChainExecutorOptions,'sleep'|'retryBaseMs'|'maxAttemptsPerStep'|'fault'>>;
};

export class AutomationService {
  readonly delivery: AutomationServiceOptions['delivery'];
  readonly prepareChannel: AutomationServiceOptions['prepareChannel'];
  readonly prepareScheduleGrant: AutomationServiceOptions['prepareScheduleGrant'];
  readonly grants: AutomationScheduleGrants;
  readonly clock: Clock;
  readonly conversations: AutomationConversationStore;
  readonly presets: AutomationPresetStore;
  readonly scheduler: AutomationScheduler;
  readonly outbox: ChannelOutbox;
  readonly pipeline: MiniChatPipeline;
  readonly chains: AutomationChainStore;
  readonly chainExecutor: AutomationChainExecutor | null;
  private readonly persistence: AutomationPersistence | null;
  private readonly prepareScheduled: AutomationServiceOptions['prepareScheduled'];
  private readonly allowSyntheticChannels: boolean;
  private schedulerRun: Promise<{ran:number;skipped:number}> | null = null;

  constructor(options: AutomationServiceOptions = {}) {
    this.delivery=options.delivery;
    this.prepareChannel=options.prepareChannel;
    this.prepareScheduleGrant=options.prepareScheduleGrant;
    this.clock = options.clock ?? new SystemClock();
    this.prepareScheduled = options.prepareScheduled;
    this.allowSyntheticChannels = options.allowSyntheticChannels === true;
    this.conversations = new AutomationConversationStore(this.clock);
    this.presets = new AutomationPresetStore();
    this.scheduler = new AutomationScheduler(this.clock);
    this.grants = new AutomationScheduleGrants({clock:this.clock,schedule:id=>this.scheduler.getSchedule(id),preset:(...args)=>this.presets.get(...args),persist:()=>this.saveState()});
    this.outbox = new ChannelOutbox(undefined, this.clock);
    this.outbox.assertSyntheticOnly();
    this.persistence = options.root ? new AutomationPersistence(options.root) : null;
    this.chains = new AutomationChainStore(this.clock, () => this.saveState());
    this.chainExecutor = options.chainEffects
      ? new AutomationChainExecutor(this.chains, options.chainEffects, { clock: this.clock, ...options.chainExecutor })
      : null;
    if (this.persistence) this.hydrate();

    const defaultHooks: PipelineHooks = {
      prepare: async () => { throw new AutomationError('automation_prepare_unavailable', 503); },
      execute: async () => { throw new AutomationError('automation_execution_unavailable', 503); },
      ...options.hooks,
    };
    this.pipeline = new MiniChatPipeline(this.conversations, defaultHooks, this.clock);
  }

  // ------------------------------------------------------------- persistência

  private collectState(): AutomationPersistedState {
    const conversations = this.conversations.exportState();
    const presets = this.presets.exportState();
    const scheduler = this.scheduler.exportState();
    const outbox = this.outbox.exportState();
    return {
      conversations: conversations.conversations,
      messages: conversations.messages,
      tasks: conversations.tasks,
      receipts: conversations.receipts,
      presets: presets.entries,
      schedules: scheduler.schedules,
      occurrences: scheduler.occurrences,
      grants: this.grants.exportState(),
      chains: this.chains.exportState(),
      outbox: outbox.records,
      outboxOrder: outbox.order,
    };
  }

  private hydrate(): void {
    const state = this.persistence!.load();
    if (!state) return;
    this.conversations.restoreState({
      conversations: state.conversations as never,
      messages: state.messages as never,
      tasks: state.tasks as never,
      receipts: state.receipts as never,
      seq: this.readSeq(state, "conversations"),
    });
    this.presets.restoreState({
      entries: state.presets as never,
      seq: this.readSeq(state, "presets"),
    });
    this.scheduler.restoreState({
      schedules: state.schedules as never,
      occurrences: state.occurrences as never,
      seq: this.readSeq(state, "schedules"),
    });
    this.grants.restoreState((state.grants??[]) as ReturnType<AutomationScheduleGrants['exportState']>);
    this.chains.restoreState((state.chains??[]) as Array<[string, ChainRun]>, this.readSeq(state, "chains"));
    this.outbox.restoreState({
      records: state.outbox as never,
      order: state.outboxOrder,
      seq: this.readSeq(state, "outbox"),
    });
    // Boot reconciliation: interrupted claims/effects settle without re-firing.
    const settledClaims = this.scheduler.reconcileInterrupted();
    const reconciled = this.chainExecutor ? this.chainExecutor.reconcileForBoot() : 0;
    if (settledClaims || reconciled) this.saveState();
  }

  private readSeq(state: AutomationPersistedState, table: string): number {
    void table;
    // Seq é derivado dos ids persistidos, não dos stores: hydrate chama isto antes de
    // restaurá-los, e um seq zerado reemitiria ids existentes (sobrescrita após reinício).
    const seqFrom = (entries: Array<[string, unknown]> | undefined, prefix: string): number =>
      (entries ?? []).reduce((max, [key]) => {
        const match = new RegExp(`^${prefix}_([0-9a-z]+)$`).exec(key);
        if (!match) return max;
        return Math.max(max, parseInt(match[1]!, 36));
      }, 0);
    return Math.max(
      seqFrom(state.conversations, "conv"),
      seqFrom(state.messages, "msg"),
      seqFrom(state.tasks, "task"),
      seqFrom(state.receipts, "rcpt"),
      seqFrom(state.schedules, "sched"),
      seqFrom(state.occurrences, "occ"),
      seqFrom(state.outbox, "out"),
      seqFrom(state.chains, "chain"),
      0,
    );
  }

  /** Snapshot pós-mutação; falha de persistência é erro duro (não silencioso). */
  private saveState(): void {
    if (!this.persistence) return;
    this.persistence.save(this.collectState());
  }

  close(): void {
    this.chainExecutor?.abortAll();
    this.persistence?.close();
  }

  // ------------------------------------------------------------------ casos

  openAutomations(principalId: string, projectId: string, title?: string) {
    const conversation = this.conversations.createConversation(principalId, projectId, title ?? "Automações");
    this.saveState();
    return conversation;
  }

  async miniChat(conversationId: string, text: string) {
    if (miniChatAuthorizesChannelSend(true)) throw new AutomationError("invariant_channel_grant");
    try { return await this.pipeline.handleUserTurn(conversationId, text); }
    finally { this.saveState(); }
  }

  /** Aprovação com ACL por principal (dono da conversa). */
  async approveTask(principalId: string, conversationId: string, taskId: string) {
    this.assertConversationOwner(principalId, conversationId);
    try { return await this.pipeline.approve(conversationId, taskId); }
    finally { this.saveState(); }
  }

  /** Cancelamento com ACL por principal (dono da conversa). */
  async cancelTask(principalId: string, conversationId: string, taskId: string) {
    this.assertConversationOwner(principalId, conversationId);
    const task = await this.pipeline.cancel(conversationId, taskId);
    this.saveState();
    return task;
  }

  private assertConversationOwner(principalId: string, conversationId: string): void {
    if (!isId(principalId)) throw new AutomationError("principal_or_project_invalid");
    const conversation = this.conversations.getConversation(conversationId);
    // 404 (não 403): não revela existência de conversa de outro principal.
    if (!conversation || conversation.principalId !== principalId) {
      throw new AutomationError("conversation_missing", 404);
    }
  }

  savePreset(
    principalId: string,
    projectId: string,
    input: { id?: string; name: string; steps: PresetStep[]; edges?: PresetEdge[] },
  ) {
    const preset = this.presets.create(principalId, projectId, input, this.clock.now().toISOString());
    this.saveState();
    return preset;
  }

  revisePreset(
    principalId: string,
    projectId: string,
    id: string,
    input: { name?: string; steps: PresetStep[]; edges?: PresetEdge[] },
  ) {
    const preset = this.presets.revise(principalId, projectId, id, input, this.clock.now().toISOString());
    this.saveState();
    return preset;
  }

  schedulePreset(
    principalId: string,
    projectId: string,
    presetId: string,
    presetVersion: number,
    kind: "interval_ms" | "cron_daily_minute",
    value: number,
  ) {
    if (!this.presets.get(principalId, projectId, presetId, presetVersion)) throw new AutomationError('preset_missing', 404);
    const schedule = this.scheduler.createSchedule({ principalId, projectId, presetId, presetVersion, kind, value });
    this.saveState();
    return schedule;
  }

  setScheduleEnabled(principalId: string, scheduleId: string, enabled: boolean) {
    const schedule = this.scheduler.getSchedule(scheduleId);
    // 404 sem vazar existência para outro principal.
    if (!schedule || schedule.principalId !== principalId) throw new AutomationError("schedule_missing", 404);
    const updated = this.scheduler.setEnabled(scheduleId, enabled);
    this.saveState();
    return updated;
  }

  /** Terminal agenda revocation: future occurrences never fire; persisted. */
  revokeSchedule(principalId: string, scheduleId: string) {
    const schedule = this.scheduler.getSchedule(scheduleId);
    if (!schedule || schedule.principalId !== principalId) throw new AutomationError("schedule_missing", 404);
    const revoked = this.scheduler.revoke(scheduleId);
    this.saveState();
    return revoked;
  }

  // ------------------------------------------------------------------ cadeias

  startChain(principalId: string, projectId: string, presetId: string, presetVersion: number, requestId?: string, input?: unknown): ChainRun {
    const preset = this.presets.get(principalId, projectId, presetId, presetVersion);
    if (!preset) throw new AutomationError("preset_missing", 404);
    if (!this.chainExecutor) throw new AutomationError("chain_effects_unavailable", 503);
    const chain = this.chainExecutor.start(principalId, projectId, preset, requestId, input);
    this.saveState();
    return chain;
  }

  getChain(principalId: string, projectId: string, chainId: string): ChainRun | undefined {
    const chain = this.chains.get(chainId);
    if (!chain || chain.principalId !== principalId || chain.projectId !== projectId) return undefined;
    return chain;
  }

  listChains(principalId: string, projectId: string): ChainRun[] {
    return this.chains.list(principalId, projectId);
  }

  cancelChain(principalId: string, projectId: string, chainId: string): ChainRun {
    if (!this.chainExecutor) throw new AutomationError("chain_effects_unavailable", 503);
    const chain = this.chainExecutor.cancel(principalId, projectId, chainId);
    this.saveState();
    return chain;
  }

  resolveChain(principalId: string, projectId: string, chainId: string, action: "keep_stopped" | "retry"): ChainRun {
    if (!this.chainExecutor) throw new AutomationError("chain_effects_unavailable", 503);
    const chain = this.chainExecutor.resolve(principalId, projectId, chainId, action);
    this.saveState();
    return chain;
  }

  /** Boot/periodic recovery: resumes running chains and pending compensations. */
  async recoverChains(): Promise<{ reconciled: number; resumed: number }> {
    if (!this.chainExecutor) return { reconciled: 0, resumed: 0 };
    const result = await this.chainExecutor.recoverAll();
    this.saveState();
    return result;
  }

  async previewChannel(channel: ChannelKind, message: ChannelMessage, scope?:{principalId:string;projectId:string}) {
    const record = await this.outbox.enqueue(channel, message, { preview: true, ...scope });
    this.saveState();
    return record;
  }

  async sendChannelSynthetic(channel: ChannelKind, message: ChannelMessage, scope?:{principalId:string;projectId:string}) {
    if (!this.allowSyntheticChannels) throw new AutomationError('channel_delivery_unavailable', 503);
    const record = await this.outbox.enqueue(channel, message, { preview: false, ...scope });
    this.saveState();
    return record;
  }

  async runScheduler(effect?: Parameters<AutomationScheduler["dispatchDue"]>[0]) {
    if (this.schedulerRun) return this.schedulerRun;
    this.schedulerRun = this.scheduler.dispatchDue(effect ?? (async (occ, schedule) => {
      const preset = this.presets.get(schedule.principalId, schedule.projectId, schedule.presetId, schedule.presetVersion);
      if (!preset) throw new AutomationError('preset_missing', 404);
      if (!this.prepareScheduled) throw new AutomationError('automation_prepare_unavailable', 503);
      return this.prepareScheduled(occ, schedule, preset);
    }), () => this.saveState()).finally(() => { try { this.saveState(); } finally { this.schedulerRun = null; } });
    return this.schedulerRun;
  }
}

export * from "./automation-types.ts";
export * from "./automation-conversation.ts";
export * from "./automation-presets.ts";
export * from "./automation-scheduler.ts";
export * from "./automation-channels.ts";
export * from "./automation-chain.ts";

export * from "./automation-http.ts";
export * from "./automation-w0-delta.ts";
export * from "./automation-runtime-facet.ts";

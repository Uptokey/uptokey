/**
 * E2-13.A — mini chat → real pipeline + task/conversation persistence.
 * Does not authorize external channels by itself (see automation-channels).
 */

import { AutomationError, type Clock, SystemClock, isId } from "./automation-types.ts";

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  taskId?: string;
};

export type AutomationTask = {
  id: string;
  conversationId: string;
  title: string;
  status: "open" | "running" | "awaiting_approval" | "succeeded" | "failed" | "cancelled";
  phase: string;
  createdAt: string;
  updatedAt: string;
  planId?: string;
  receiptId?: string;
  errorCode?: string;
};

export type AutomationConversation = {
  id: string;
  principalId: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
  taskIds: string[];
};

export type PipelineReceipt = {
  id: string;
  taskId: string;
  requestId: string;
  phase: "receipt";
  status: "succeeded" | "failed" | "cancelled";
  createdAt: string;
  summary: string;
  effects: readonly string[];
};

type StoreState = {
  conversations: Map<string, AutomationConversation>;
  messages: Map<string, ConversationMessage>;
  tasks: Map<string, AutomationTask>;
  receipts: Map<string, PipelineReceipt>;
  seq: number;
};

export class AutomationConversationStore {
  private readonly state: StoreState = {
    conversations: new Map(),
    messages: new Map(),
    tasks: new Map(),
    receipts: new Map(),
    seq: 0,
  };
  private readonly clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  private next(prefix: string): string {
    this.state.seq += 1;
    return `${prefix}_${this.state.seq.toString(36)}`;
  }

  createConversation(principalId: string, projectId: string, title = "Automations"): AutomationConversation {
    if (!isId(principalId) || !isId(projectId)) throw new AutomationError("principal_or_project_invalid");
    const now = this.clock.now().toISOString();
    const conv: AutomationConversation = {
      id: this.next("conv"),
      principalId,
      projectId,
      title: String(title).slice(0, 200),
      createdAt: now,
      updatedAt: now,
      messageIds: [],
      taskIds: [],
    };
    this.state.conversations.set(conv.id, conv);
    return structuredClone(conv);
  }

  getConversation(id: string): AutomationConversation | undefined {
    const c = this.state.conversations.get(id);
    return c ? structuredClone(c) : undefined;
  }

  listMessages(conversationId: string): ConversationMessage[] {
    const c = this.state.conversations.get(conversationId);
    if (!c) throw new AutomationError("conversation_missing", 404);
    return c.messageIds.map((id) => structuredClone(this.state.messages.get(id)!));
  }

  listTasks(conversationId: string): AutomationTask[] {
    const c = this.state.conversations.get(conversationId);
    if (!c) throw new AutomationError("conversation_missing", 404);
    return c.taskIds.map((id) => structuredClone(this.state.tasks.get(id)!));
  }

  getTask(taskId: string): AutomationTask | undefined {
    const t = this.state.tasks.get(taskId);
    return t ? structuredClone(t) : undefined;
  }

  getReceipt(receiptId: string): PipelineReceipt | undefined {
    const r = this.state.receipts.get(receiptId);
    return r ? structuredClone(r) : undefined;
  }

  /** Append user turn and open a task bound to the conversation (persist before pipeline). */
  postUserMessage(conversationId: string, text: string): { message: ConversationMessage; task: AutomationTask } {
    const c = this.state.conversations.get(conversationId);
    if (!c) throw new AutomationError("conversation_missing", 404);
    const body = String(text ?? "").trim();
    if (!body || body.length > 16_384) throw new AutomationError("message_invalid");
    const now = this.clock.now().toISOString();
    const task: AutomationTask = {
      id: this.next("task"),
      conversationId,
      title: body.slice(0, 120),
      status: "open",
      phase: "config",
      createdAt: now,
      updatedAt: now,
    };
    const message: ConversationMessage = {
      id: this.next("msg"),
      role: "user",
      text: body,
      createdAt: now,
      taskId: task.id,
    };
    this.state.tasks.set(task.id, task);
    this.state.messages.set(message.id, message);
    c.messageIds.push(message.id);
    c.taskIds.push(task.id);
    c.updatedAt = now;
    return { message: structuredClone(message), task: structuredClone(task) };
  }

  updateTask(taskId: string, patch: Partial<Pick<AutomationTask, "status" | "phase" | "planId" | "receiptId" | "errorCode">>): AutomationTask {
    const t = this.state.tasks.get(taskId);
    if (!t) throw new AutomationError("task_missing", 404);
    Object.assign(t, patch, { updatedAt: this.clock.now().toISOString() });
    const c = this.state.conversations.get(t.conversationId);
    if (c) c.updatedAt = t.updatedAt;
    return structuredClone(t);
  }

  appendAssistant(conversationId: string, text: string, taskId?: string): ConversationMessage {
    const c = this.state.conversations.get(conversationId);
    if (!c) throw new AutomationError("conversation_missing", 404);
    const now = this.clock.now().toISOString();
    const message: ConversationMessage = {
      id: this.next("msg"),
      role: "assistant",
      text: String(text).slice(0, 16_384),
      createdAt: now,
      taskId,
    };
    this.state.messages.set(message.id, message);
    c.messageIds.push(message.id);
    c.updatedAt = now;
    return structuredClone(message);
  }

  saveReceipt(receipt: Omit<PipelineReceipt, "id" | "createdAt"> & { id?: string }): PipelineReceipt {
    const full: PipelineReceipt = {
      ...receipt,
      id: receipt.id ?? this.next("rcpt"),
      createdAt: this.clock.now().toISOString(),
    };
    this.state.receipts.set(full.id, full);
    return structuredClone(full);
  }

  /** UI snapshot for #automations reload — no inference side effects. */
  uiSnapshot(conversationId: string): {
    conversation: AutomationConversation;
    messages: ConversationMessage[];
    tasks: AutomationTask[];
    receipts: PipelineReceipt[];
  } {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new AutomationError("conversation_missing", 404);
    const tasks = this.listTasks(conversationId);
    const receipts = tasks
      .map((t) => (t.receiptId ? this.state.receipts.get(t.receiptId) : undefined))
      .filter((r): r is PipelineReceipt => !!r)
      .map((r) => structuredClone(r));
    return { conversation, messages: this.listMessages(conversationId), tasks, receipts };
  }

  /** Durable persistence (E2-13 correção): serializa o estado completo. */
  exportState(): {
    conversations: Array<[string, AutomationConversation]>;
    messages: Array<[string, ConversationMessage]>;
    tasks: Array<[string, AutomationTask]>;
    receipts: Array<[string, PipelineReceipt]>;
    seq: number;
  } {
    return {
      conversations: [...this.state.conversations.entries()],
      messages: [...this.state.messages.entries()],
      tasks: [...this.state.tasks.entries()],
      receipts: [...this.state.receipts.entries()],
      seq: this.state.seq,
    };
  }

  restoreState(state: {
    conversations: Array<[string, AutomationConversation]>;
    messages: Array<[string, ConversationMessage]>;
    tasks: Array<[string, AutomationTask]>;
    receipts: Array<[string, PipelineReceipt]>;
    seq: number;
  }): void {
    this.state.conversations = new Map(state.conversations);
    this.state.messages = new Map(state.messages);
    this.state.tasks = new Map(state.tasks);
    this.state.receipts = new Map(state.receipts);
    this.state.seq = state.seq;
  }
}

export type PipelineHooks = {
  /** Prepare a plan from user text; returns opaque plan id. */
  prepare(input: { conversationId: string; taskId: string; text: string }): Promise<{ planId: string; requiresApproval: boolean; preview: string }>;
  /** Execute after approval (or when approval not required). */
  execute(input: { conversationId: string; taskId: string; planId: string }): Promise<{ effects: string[]; summary: string }>;
  /** Stop the canonical execution, if any. Rejection must not be reported as cancellation. */
  cancel?(input: { conversationId: string; taskId: string; planId: string }): Promise<void>;
};

/**
 * Mini-chat pipeline owner: persists every phase transition on the conversation/task store.
 * Approval is explicit — AI connected ≠ external send authorized.
 */
export class MiniChatPipeline {
  private readonly store: AutomationConversationStore;
  private readonly hooks: PipelineHooks;
  private readonly clock: Clock;

  constructor(
    store: AutomationConversationStore,
    hooks: PipelineHooks,
    clock: Clock = new SystemClock(),
  ) {
    this.store = store;
    this.hooks = hooks;
    this.clock = clock;
  }

  async handleUserTurn(conversationId: string, text: string): Promise<{
    task: AutomationTask;
    phase: string;
    preview?: string;
    receipt?: PipelineReceipt;
  }> {
    const { task } = this.store.postUserMessage(conversationId, text);
    this.store.updateTask(task.id, { status: "running", phase: "prep" });
    let prepared;
    try { prepared = await this.hooks.prepare({ conversationId, taskId: task.id, text }); }
    catch (error) {
      if (this.store.getTask(task.id)?.status !== 'cancelled') {
        this.store.updateTask(task.id, {status:'failed',phase:'prep',errorCode:error instanceof AutomationError?error.code:'prepare_failed'});
      }
      throw error;
    }
    if (this.store.getTask(task.id)?.status === 'cancelled') throw new AutomationError('automation_task_cancelled',409);
    this.store.updateTask(task.id, { planId: prepared.planId, phase: "prep" });
    if (prepared.requiresApproval) {
      const awaiting = this.store.updateTask(task.id, { status: "awaiting_approval", phase: "approval" });
      this.store.appendAssistant(conversationId, `Aguardando aprovação: ${prepared.preview}`, task.id);
      return { task: awaiting, phase: "approval", preview: prepared.preview };
    }
    return this.continueAfterApproval(conversationId, task.id);
  }

  async approve(conversationId: string, taskId: string): Promise<{ task: AutomationTask; receipt: PipelineReceipt }> {
    const task = this.store.getTask(taskId);
    if (!task || task.conversationId !== conversationId) throw new AutomationError("task_missing", 404);
    if (task.status !== "awaiting_approval") throw new AutomationError("task_not_awaiting_approval", 409);
    return this.continueAfterApproval(conversationId, taskId);
  }

  async cancel(conversationId: string, taskId: string): Promise<AutomationTask> {
    const task = this.store.getTask(taskId);
    if (!task || task.conversationId !== conversationId) throw new AutomationError("task_missing", 404);
    if (!["open", "running", "awaiting_approval"].includes(task.status)) {
      throw new AutomationError("task_not_cancellable", 409);
    }
    if (task.planId) {
      if (this.hooks.cancel) await this.hooks.cancel({ conversationId, taskId, planId: task.planId });
      else if (task.status === 'running') throw new AutomationError('automation_cancellation_unavailable',503);
    }
    const current = this.store.getTask(taskId)!;
    if (current.status === 'cancelled') return current;
    if (!['open','running','awaiting_approval'].includes(current.status)) throw new AutomationError('task_not_cancellable',409);
    const cancelled = this.store.updateTask(taskId, { status: "cancelled", phase: "receipt" });
    this.store.appendAssistant(conversationId, "Automação cancelada.", taskId);
    return cancelled;
  }

  private async continueAfterApproval(conversationId: string, taskId: string): Promise<{
    task: AutomationTask;
    receipt: PipelineReceipt;
    phase: string;
  }> {
    const task = this.store.getTask(taskId);
    if (!task?.planId) throw new AutomationError("plan_missing", 409);
    this.store.updateTask(taskId, { status: "running", phase: "execution" });
    try {
      const result = await this.hooks.execute({ conversationId, taskId, planId: task.planId });
      if (this.store.getTask(taskId)?.status === 'cancelled') throw new AutomationError('automation_task_cancelled',409);
      const receipt = this.store.saveReceipt({
        taskId,
        requestId: `req_${taskId}`,
        phase: "receipt",
        status: "succeeded",
        summary: result.summary,
        effects: result.effects,
      });
      const done = this.store.updateTask(taskId, {
        status: "succeeded",
        phase: "receipt",
        receiptId: receipt.id,
      });
      this.store.appendAssistant(conversationId, result.summary, taskId);
      // ui + reload are read-only projections
      this.store.updateTask(taskId, { phase: "ui" });
      this.store.updateTask(taskId, { phase: "reload" });
      return { task: this.store.getTask(taskId)!, receipt, phase: "reload" };
    } catch (err) {
      if (this.store.getTask(taskId)?.status === 'cancelled') throw err;
      const code = err instanceof AutomationError ? err.code : "execution_failed";
      // The canonical W5 run has not completed. This is an unmet approval
      // precondition, not a dispatched effect or a failed automation receipt.
      // Preserve a cancellation that arrived while the workspace was checked.
      if (code === 'automation_use_workspace_consent') {
        if (this.store.getTask(taskId)?.status === 'running') {
          this.store.updateTask(taskId, { status: 'awaiting_approval', phase: 'approval' });
        }
        throw err;
      }
      const receipt = this.store.saveReceipt({
        taskId,
        requestId: `req_${taskId}`,
        phase: "receipt",
        status: "failed",
        summary: code,
        effects: [],
      });
      this.store.updateTask(taskId, {
        status: "failed",
        phase: "receipt",
        receiptId: receipt.id,
        errorCode: code,
      });
      this.store.appendAssistant(conversationId, `Falha: ${code}`, taskId);
      throw err;
    }
  }
}

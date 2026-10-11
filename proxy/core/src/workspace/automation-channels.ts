/**
 * E2-13.D — Brevo / Resend / Slack channels with outbox + preview.
 * SYNTHETIC providers only — no real keys, spend, or external messages.
 */

import { createHash } from "node:crypto";
import { AutomationError, type Clock, SystemClock, isId } from "./automation-types.ts";

export type ChannelKind = "brevo" | "resend" | "slack";

export type ChannelMessage = {
  to: string;
  subject?: string;
  body: string;
  /** Slack channel or email recipient already in `to`. */
  threadKey?: string;
};

export type OutboxRecord = {
  principalId?: string;
  projectId?: string;
  id: string;
  channel: ChannelKind;
  fingerprint: string;
  preview: boolean;
  status: "queued" | "previewed" | "delivered_synthetic" | "failed" | "suppressed_duplicate";
  createdAt: string;
  deliveredAt?: string;
  providerMessageId?: string;
  payload: ChannelMessage;
  errorCode?: string;
};

export type SyntheticProviderResult = {
  providerMessageId: string;
  accepted: boolean;
};

export interface ChannelProvider {
  readonly kind: ChannelKind;
  /** Never touches network in synthetic mode. */
  send(message: ChannelMessage, opts: { preview: boolean }): Promise<SyntheticProviderResult>;
}

function fingerprint(channel: ChannelKind, message: ChannelMessage, preview: boolean): string {
  const material = JSON.stringify({
    channel,
    preview,
    to: message.to,
    subject: message.subject ?? "",
    body: message.body,
    threadKey: message.threadKey ?? "",
  });
  return createHash("sha256").update(material).digest("hex");
}

export class SyntheticBrevoProvider implements ChannelProvider {
  readonly kind = "brevo" as const;
  private n = 0;
  async send(message: ChannelMessage, opts: { preview: boolean }): Promise<SyntheticProviderResult> {
    if (!message.to.includes("@")) throw new AutomationError("brevo_recipient_invalid");
    if (opts.preview) return { providerMessageId: `brevo_preview_${++this.n}`, accepted: true };
    return { providerMessageId: `brevo_synth_${++this.n}`, accepted: true };
  }
}

export class SyntheticResendProvider implements ChannelProvider {
  readonly kind = "resend" as const;
  private n = 0;
  async send(message: ChannelMessage, opts: { preview: boolean }): Promise<SyntheticProviderResult> {
    if (!message.to.includes("@")) throw new AutomationError("resend_recipient_invalid");
    if (opts.preview) return { providerMessageId: `resend_preview_${++this.n}`, accepted: true };
    return { providerMessageId: `resend_synth_${++this.n}`, accepted: true };
  }
}

export class SyntheticSlackProvider implements ChannelProvider {
  readonly kind = "slack" as const;
  private n = 0;
  async send(message: ChannelMessage, opts: { preview: boolean }): Promise<SyntheticProviderResult> {
    if (!message.to.startsWith("#") && !message.to.startsWith("C")) {
      throw new AutomationError("slack_target_invalid");
    }
    if (opts.preview) return { providerMessageId: `slack_preview_${++this.n}`, accepted: true };
    return { providerMessageId: `slack_synth_${++this.n}`, accepted: true };
  }
}

export class ChannelOutbox {
  private records = new Map<string, OutboxRecord>(); // fingerprint -> record
  private order: string[] = [];
  private seq = 0;
  private readonly providers: Map<ChannelKind, ChannelProvider>;
  private readonly clock: Clock;

  constructor(
    providers?: ChannelProvider[],
    clock: Clock = new SystemClock(),
  ) {
    this.clock = clock;
    const list = providers ?? [
      new SyntheticBrevoProvider(),
      new SyntheticResendProvider(),
      new SyntheticSlackProvider(),
    ];
    this.providers = new Map(list.map((p) => [p.kind, p]));
  }

  list(): OutboxRecord[] {
    return this.order.map((fp) => structuredClone(this.records.get(fp)!));
  }

  getByFingerprint(fp: string): OutboxRecord | undefined {
    const r = this.records.get(fp);
    return r ? structuredClone(r) : undefined;
  }

  /**
   * Enqueue + optionally deliver. Preview never marks external send;
   * synthetic deliver still stays local. Duplicate fingerprint is suppressed.
   */
  async enqueue(
    channel: ChannelKind,
    message: ChannelMessage,
    opts: { preview: boolean; principalId?: string; projectId?: string },
  ): Promise<OutboxRecord> {
    if (!this.providers.has(channel)) throw new AutomationError("channel_unknown", 404);
    if (!message?.to || typeof message.body !== "string" || !message.body.trim()) {
      throw new AutomationError("channel_message_invalid");
    }
    if (message.body.length > 32_768) throw new AutomationError("channel_body_too_large");
    const fp = createHash('sha256').update(JSON.stringify([opts.principalId,opts.projectId,fingerprint(channel, message, opts.preview)])).digest('hex');
    const existing = this.records.get(fp);
    if (existing && ["previewed", "delivered_synthetic", "queued"].includes(existing.status)) {
      return {
        ...structuredClone(existing),
        status: "suppressed_duplicate",
      };
    }
    const record: OutboxRecord = {
      id: `out_${(++this.seq).toString(36)}`,
      ...(opts.principalId&&opts.projectId?{principalId:opts.principalId,projectId:opts.projectId}:{}),
      channel,
      fingerprint: fp,
      preview: opts.preview,
      status: "queued",
      createdAt: this.clock.now().toISOString(),
      payload: structuredClone(message),
    };
    this.records.set(fp, record);
    this.order.push(fp);
    return this.flush(fp);
  }

  private async flush(fp: string): Promise<OutboxRecord> {
    const record = this.records.get(fp);
    if (!record) throw new AutomationError("outbox_missing", 404);
    if (record.status === "previewed" || record.status === "delivered_synthetic") {
      return structuredClone(record);
    }
    const provider = this.providers.get(record.channel)!;
    try {
      const result = await provider.send(record.payload, { preview: record.preview });
      record.providerMessageId = result.providerMessageId;
      record.deliveredAt = this.clock.now().toISOString();
      record.status = record.preview ? "previewed" : "delivered_synthetic";
      return structuredClone(record);
    } catch (err) {
      record.status = "failed";
      record.errorCode = err instanceof AutomationError ? err.code : "channel_send_failed";
      return structuredClone(record);
    }
  }

  /** Assert no provider string looks like a live API host — fixture hygiene. */
  assertSyntheticOnly(): void {
    for (const p of this.providers.values()) {
      const name = p.constructor.name;
      if (!name.startsWith("Synthetic")) throw new AutomationError("non_synthetic_provider");
    }
  }

  /** Durable persistence (E2-13 correção): outbox sintética + ordem. */
  exportState(): { records: Array<[string, OutboxRecord]>; order: string[]; seq: number } {
    return { records: [...this.records.entries()], order: [...this.order], seq: this.seq };
  }

  restoreState(state: { records: Array<[string, OutboxRecord]>; order: string[]; seq: number }): void {
    this.records = new Map(state.records);
    this.order = [...state.order];
    this.seq = state.seq;
  }
}

/** Mini-chat must not imply channel grant; explicit preview/send through outbox. */
export function miniChatAuthorizesChannelSend(_connectedModels: boolean): false {
  return false;
}

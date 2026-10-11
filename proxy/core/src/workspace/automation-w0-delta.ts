/**
 * E2-13 additive W0-shaped types for recipe/composition/workflow/channel automation.
 * Prefer merging into sync-contract when the integrator owns that window.
 * This module is the exclusive consumer-side seam until then — no parallel schema fork.
 */

export const AUTOMATION_CONTRACT_REVISION = "e2-13.w0.1" as const;

export type W0AutomationChannelKind = "brevo" | "resend" | "slack";

export type W0AutomationPresetStep = {
  id: string;
  kind: "recipe" | "composition" | "channel_preview" | "channel_send" | "chat";
  ref: string;
  bindings?: Record<string, string>;
};

export type W0AutomationPreset = {
  schemaVersion: 1;
  contractRevision: typeof AUTOMATION_CONTRACT_REVISION;
  id: string;
  version: number;
  name: string;
  principalId: string;
  projectId: string;
  steps: readonly W0AutomationPresetStep[];
  edges: readonly { from: string; to: string }[];
  createdAt: string;
  superseded?: boolean;
};

export type W0AutomationSchedule = {
  schemaVersion: 1;
  contractRevision: typeof AUTOMATION_CONTRACT_REVISION;
  id: string;
  principalId: string;
  projectId: string;
  presetId: string;
  presetVersion: number;
  kind: "interval_ms" | "cron_daily_minute";
  value: number;
  enabled: boolean;
  createdAt: string;
};

export type W0AutomationOutboxRecord = {
  schemaVersion: 1;
  contractRevision: typeof AUTOMATION_CONTRACT_REVISION;
  id: string;
  channel: W0AutomationChannelKind;
  fingerprint: string;
  preview: boolean;
  status: "queued" | "previewed" | "delivered_synthetic" | "failed" | "suppressed_duplicate";
  createdAt: string;
  deliveredAt?: string;
  providerMessageId?: string;
};

/** Map exclusive preset → W0 envelope (additive export for sync-contract merge). */
export function toW0Preset(p: {
  id: string;
  version: number;
  name: string;
  principalId: string;
  projectId: string;
  steps: readonly W0AutomationPresetStep[];
  edges: readonly { from: string; to: string }[];
  createdAt: string;
  superseded?: boolean;
}): W0AutomationPreset {
  return {
    schemaVersion: 1,
    contractRevision: AUTOMATION_CONTRACT_REVISION,
    ...p,
  };
}

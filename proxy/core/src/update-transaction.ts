import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { updateTransactionPath } from "./paths.ts";
import type { UpdatePlatform } from "./update-manifest.ts";
import { basename, isAbsolute, resolve } from "node:path";
import { readBoundedJson } from "@uptokey/sync-contract/limits";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";
import { cancelStream } from "./stream-lifecycle.ts";
import { createDeadline } from "./deadline.ts";

export type UpdateState = "staged" | "installing" | "awaiting-health" | "healthy" | "rolling-back" | "rolled-back" | "failed";
export interface UpdateTransaction {
  schema: "uptokey-update-transaction-v1"; id: string; state: UpdateState; platform: UpdatePlatform; fromVersion: string; toVersion: string;
  artifactName: string; artifactPath: string; artifactSha256: string; createdAt: string; updatedAt: string; failure?: string;
  candidatePid?: number;
}

const transitions: Record<UpdateState, UpdateState[]> = {
  staged: ["installing", "failed"], installing: ["awaiting-health", "rolling-back", "failed"], "awaiting-health": ["healthy", "rolling-back", "failed"],
  healthy: [], "rolling-back": ["rolled-back", "failed"], "rolled-back": [], failed: [],
};
const journalQueues = new Map<string, Promise<unknown>>();

export class UpdateJournal {
  constructor(privatePath = updateTransactionPath()) { this.path = privatePath; }
  private readonly path: string;
  get location(): string { return this.path; }

  async begin(input: { platform: UpdatePlatform; fromVersion: string; toVersion: string; artifactName: string; artifactPath: string; artifactSha256: string }, now = new Date()): Promise<UpdateTransaction> {
    return journalExclusive(this.path, async () => {
      const existing = await this.load(); if (existing && !terminal(existing.state)) throw new Error("update_transaction_already_active");
      if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.fromVersion) || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.toVersion)) throw new Error("update_transaction_version_invalid");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.artifactName) || !/^[a-f0-9]{64}$/.test(input.artifactSha256)) throw new Error("update_transaction_artifact_invalid");
      if (!isAbsolute(input.artifactPath) || resolve(input.artifactPath) !== input.artifactPath || basename(input.artifactPath) !== input.artifactName) throw new Error("update_transaction_artifact_path_invalid");
      const timestamp = now.toISOString(); const transaction: UpdateTransaction = { schema: "uptokey-update-transaction-v1", id: randomUUID(), state: "staged", ...input, createdAt: timestamp, updatedAt: timestamp };
      await writeJsonAtomic(this.path, transaction); return transaction;
    });
  }

  async transition(expected: UpdateState, next: UpdateState, now = new Date(), failure?: string): Promise<UpdateTransaction> {
    return journalExclusive(this.path, async () => {
      const current = await this.load(); if (!current || current.state !== expected) throw new Error("update_transaction_state_mismatch");
      if (!transitions[expected].includes(next)) throw new Error("update_transaction_transition_invalid");
      const updated = { ...current, state: next, updatedAt: now.toISOString(), ...(failure ? { failure: sanitizeFailure(failure) } : {}) };
      await writeJsonAtomic(this.path, updated); return updated;
    });
  }

  async recordCandidatePid(pid: number, now = new Date()): Promise<UpdateTransaction> {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("update_candidate_pid_invalid");
    return journalExclusive(this.path, async () => {
      const current = await this.load(); if (!current || current.state !== "installing") throw new Error("update_candidate_pid_state_mismatch");
      if (current.candidatePid === pid) return current;
      if (current.candidatePid !== undefined) throw new Error("update_candidate_pid_state_mismatch");
      const updated = { ...current, candidatePid: pid, updatedAt: now.toISOString() }; await writeJsonAtomic(this.path, updated); return updated;
    });
  }

  async load(): Promise<UpdateTransaction | undefined> {
    const value = await readJson<UpdateTransaction | undefined>(this.path, undefined); if (!value) return undefined; validate(value); return value;
  }
}

function journalExclusive<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path); const previous = journalQueues.get(key) ?? Promise.resolve(); const next = previous.then(operation, operation); journalQueues.set(key, next);
  const cleanup = () => { if (journalQueues.get(key) === next) journalQueues.delete(key); };
  void next.then(cleanup, cleanup); return next;
}

export function updateRecoveryAction(transaction: UpdateTransaction, now = new Date(), healthTimeoutMs = 60_000): "resume-install" | "wait-health" | "rollback" | "cleanup" | "none" {
  if (transaction.state === "staged") return "resume-install";
  if (transaction.state === "installing" || transaction.state === "rolling-back") return "rollback";
  if (transaction.state === "awaiting-health") return now.getTime() - Date.parse(transaction.updatedAt) >= healthTimeoutMs ? "rollback" : "wait-health";
  if (transaction.state === "healthy" || transaction.state === "rolled-back" || transaction.state === "failed") return "cleanup";
  return "none";
}

export async function waitForUpdateHealth(expectedVersion: string, options: { timeoutMs?: number; intervalMs?: number; requestTimeoutMs?: number; fetchImpl?: (input: string, init: RequestInit) => Promise<Response>; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<void> {
  const timeout = boundedDuration(options.timeoutMs ?? 60_000, 600_000); const interval = boundedDuration(options.intervalMs ?? 500, 10_000); const requestTimeout = boundedDuration(options.requestTimeoutMs ?? 2_000, 10_000); const now = options.now ?? Date.now; const deadline = now() + timeout;
  while (now() <= deadline) {
    try {
      const requestDeadline = createDeadline(Math.min(requestTimeout, Math.max(1, deadline - now() + 1)));
      try {
        const response = await (options.fetchImpl ?? fetch)("http://127.0.0.1:21435/health", { redirect: "error", signal: requestDeadline.signal, headers: { Host: "127.0.0.1:21435", Accept: "application/json" } });
        const parsed = response.status === 200 ? await readBoundedJson(response, 4 * 1024) : undefined;
        if (response.status !== 200) cancelStream(response.body);
        const body = parsed?.ok && record(parsed.value) && Object.keys(parsed.value).sort().join(",") === "data_plane,status,version" ? parsed.value : {};
        if (body.status === "ok" && body.data_plane === "local" && body.version === expectedVersion) return;
      } finally { requestDeadline.clear(); }
    } catch { /* daemon ainda reiniciando */ }
    await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(interval);
  }
  throw new Error("update_health_timeout");
}
function boundedDuration(value: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("update_health_duration_invalid"); return value; }

function validate(value: UpdateTransaction): void {
  const allowed = new Set(["schema", "id", "state", "platform", "fromVersion", "toVersion", "artifactName", "artifactPath", "artifactSha256", "createdAt", "updatedAt", "failure", "candidatePid"]);
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => !allowed.has(key)) || value.schema !== "uptokey-update-transaction-v1" || !transitions[value.state]
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) || !["macos", "windows", "linux"].includes(value.platform)
    || !validVersion(value.fromVersion) || !validVersion(value.toVersion) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.artifactName) || !/^[a-f0-9]{64}$/.test(value.artifactSha256)
    || !isAbsolute(value.artifactPath) || resolve(value.artifactPath) !== value.artifactPath || basename(value.artifactPath) !== value.artifactName || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
    || value.failure !== undefined && (typeof value.failure !== "string" || value.failure.length < 1 || value.failure.length > 160 || /[\r\n\t\0]/.test(value.failure))
    || value.candidatePid !== undefined && (!Number.isSafeInteger(value.candidatePid) || value.candidatePid <= 1)) throw new Error("update_transaction_invalid");
}
function terminal(state: UpdateState): boolean { return state === "healthy" || state === "rolled-back" || state === "failed"; }
function sanitizeFailure(value: string): string { return /^update_[a-z0-9_]{1,120}$/.test(value) ? value : "update_operation_failed"; }
function validVersion(value: unknown): value is string { return typeof value === "string" && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value); }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }

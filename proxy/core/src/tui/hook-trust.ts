/**
 * Repository hook trust is opt-in and pinned to the hooks file's exact hash.
 * Any edit invalidates trust. Records live in the user profile so a repository
 * cannot grant trust to itself.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";

export interface HookTrustRecord {
  root: string;
  hash: string;
  trustedAt: string;
}

type TrustStore = Record<string, HookTrustRecord>;

export function hookTrustStorePath(): string {
  const base = process.env.UPTOKEY_TUI_CONFIG_DIR ?? join(homedir(), ".uptokey", "tui");
  return join(base, "hook-trust.json");
}

export function hashHooksSource(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function trustKey(root: string): string {
  return normalize(root).toLowerCase();
}

async function readStore(): Promise<TrustStore> {
  try {
    const raw = await readFile(hookTrustStorePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as TrustStore;
  } catch {
    return {};
  }
}

async function writeStore(store: TrustStore): Promise<void> {
  const path = hookTrustStorePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}

/**
 * Returns the trust record for this repository, but only when the recorded
 * hash matches the current hooks content. A changed hooks file is untrusted.
 */
export async function getHookTrust(root: string, content: string): Promise<HookTrustRecord | null> {
  const store = await readStore();
  const record = store[trustKey(root)];
  if (!record) return null;
  if (record.hash !== hashHooksSource(content)) return null;
  return record;
}

/** Records an explicit user trust gesture for this repository + content hash. */
export async function trustHooks(root: string, content: string): Promise<HookTrustRecord> {
  const store = await readStore();
  const record: HookTrustRecord = {
    root: normalize(root),
    hash: hashHooksSource(content),
    trustedAt: new Date().toISOString(),
  };
  store[trustKey(root)] = record;
  await writeStore(store);
  return record;
}

/** Removes any trust record for the repository (all hashes). */
export async function revokeHookTrust(root: string): Promise<void> {
  const store = await readStore();
  delete store[trustKey(root)];
  await writeStore(store);
}

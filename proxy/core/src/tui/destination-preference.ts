/**
 * Device preference for the next TUI conversation. No key or transcript is stored.
 * An existing conversation's canonical processing policy always takes precedence.
 */
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readJson, writeJsonAtomic } from "../atomic-json.ts";
import { dataDir } from "../paths.ts";
import { isProvider } from "../provider-registry.ts";
import type { ProcessingPolicy } from "./state.ts";

export interface TuiDestinationPreference {
  providerId: string;
  model: string;
  routingComboId?: string;
  processingPolicy: ProcessingPolicy;
}

const writes = new Map<string, Promise<void>>();

function location(baseUrl: string): { origin: string; path: string } {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("tui_loopback_required");
  }
  const origin = endpoint.origin;
  // Share the canonical settings root without loading the SettingsStore database.
  const root = process.env.UPTOKEY_SETTINGS_DIR || join(dataDir(), "settings");
  const service = createHash("sha256").update(origin).digest("hex");
  return { origin, path: join(resolve(root), `tui-destination-${service}.json`) };
}

function validate(value: unknown): TuiDestinationPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tui_destination_preference_invalid");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["providerId", "model", "routingComboId", "processingPolicy"].includes(key))
    || !(isProvider(item.providerId) || item.providerId === "uptokey-hosted")
    || typeof item.model !== "string" || !item.model.trim() || item.model !== item.model.trim()
    || item.model.length > 512 || /[\x00-\x1f\x7f]/.test(item.model)
    || (item.routingComboId !== undefined && (typeof item.routingComboId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.routingComboId)))
    || (item.processingPolicy !== "local_only" && item.processingPolicy !== "external_allowed")) {
    throw new Error("tui_destination_preference_invalid");
  }
  return { providerId: item.providerId, model: item.model,
    ...(item.routingComboId === undefined ? {} : { routingComboId: item.routingComboId as string }),
    processingPolicy: item.processingPolicy as ProcessingPolicy };
}

/** Missing is normal; corrupt preferences are reported and never silently replaced. */
export async function loadDestinationPreference(baseUrl: string): Promise<TuiDestinationPreference | undefined> {
  const target = location(baseUrl);
  await writes.get(target.path);
  const stored = await readJson<unknown>(target.path, undefined, 4096);
  if (stored === undefined) return undefined;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("tui_destination_preference_invalid");
  const record = stored as Record<string, unknown>;
  if (record.version !== 1 || record.service !== target.origin
    || Object.keys(record).some(key => !["version", "service", "destination"].includes(key))) throw new Error("tui_destination_preference_invalid");
  return validate(record.destination);
}

/** Call after an explicit successful choice; callers skip temporary/ephemeral sessions. */
export function saveDestinationPreference(baseUrl: string, preference: TuiDestinationPreference): Promise<void> {
  // Snapshot before waiting: later caller mutation cannot alter a queued selection.
  const destination = validate(preference);
  const target = location(baseUrl);
  const previous = writes.get(target.path) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => writeJsonAtomic(target.path,
    { version: 1, service: target.origin, destination }, { maximum: 4096 }));
  writes.set(target.path, pending);
  void pending.finally(() => { if (writes.get(target.path) === pending) writes.delete(target.path); }).catch(() => undefined);
  return pending;
}

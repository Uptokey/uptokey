import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { canonicalHttpsOrigin, canonicalMagicDnsName } from "../src/tailnet-address.mjs";
import { TAILNET_EVIDENCE_CHECK_NAMES, TAILNET_EVIDENCE_SCHEMA_VERSION } from "../src/tailnet-evidence-contract.mjs";

const MAX_EVIDENCE_BYTES = 64 * 1024;
const ROOT_KEYS = ["addressAuthoritySha256", "checks", "controlOrigin", "dashboardOrigin", "dnsName", "harnessSha256", "nodeVersion", "platform", "requestTimeoutMs", "schemaVersion", "testedAt"];
const ROOT_KEY_ORDER = ["schemaVersion", "testedAt", "platform", "nodeVersion", "dnsName", "controlOrigin", "dashboardOrigin", "requestTimeoutMs", "harnessSha256", "addressAuthoritySha256", "checks"];
const CHECK_KEY_ORDER = ["name", "passed", "durationMs"];
const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const EVIDENCE_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

export interface TailnetEvidenceDigests { harnessSha256: string; addressAuthoritySha256: string }

export async function computeTailnetEvidenceDigests(): Promise<TailnetEvidenceDigests> {
  const [harness, authority] = await Promise.all([
    readFile(new URL("./e2e-tailnet.mjs", import.meta.url)),
    readFile(new URL("../src/tailnet-address.mjs", import.meta.url))
  ]);
  return { harnessSha256: digest(harness), addressAuthoritySha256: digest(authority) };
}

export function verifyTailnetEvidence(value: unknown, expected: TailnetEvidenceDigests, nowMs: number = Date.now()): boolean {
  if (!record(value) || !exactKeys(value, ROOT_KEYS) || !orderedKeys(value, ROOT_KEY_ORDER) || value.schemaVersion !== TAILNET_EVIDENCE_SCHEMA_VERSION || value.platform !== "darwin" || value.requestTimeoutMs !== 8_000) return false;
  if (!canonicalIso(value.testedAt) || !Number.isFinite(nowMs) || nowMs < 0) return false;
  const testedAtMs = Date.parse(value.testedAt);
  if (testedAtMs > nowMs + EVIDENCE_FUTURE_TOLERANCE_MS || nowMs - testedAtMs > EVIDENCE_MAX_AGE_MS) return false;
  if (typeof value.nodeVersion !== "string" || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value.nodeVersion)) return false;
  if (!canonicalMagicDnsName(value.dnsName) || !canonicalHttpsOrigin(value.dashboardOrigin) || value.controlOrigin !== `https://${value.dnsName}:21436`) return false;
  if (value.harnessSha256 !== expected.harnessSha256 || value.addressAuthoritySha256 !== expected.addressAuthoritySha256 || !lowerSha256(value.harnessSha256) || !lowerSha256(value.addressAuthoritySha256)) return false;
  if (!Array.isArray(value.checks) || value.checks.length !== TAILNET_EVIDENCE_CHECK_NAMES.length) return false;
  return value.checks.every((entry, index) => record(entry) && exactKeys(entry, ["durationMs", "name", "passed"]) && orderedKeys(entry, CHECK_KEY_ORDER) && entry.name === TAILNET_EVIDENCE_CHECK_NAMES[index] && entry.passed === true && Number.isSafeInteger(entry.durationMs) && (entry.durationMs as number) >= 0 && (entry.durationMs as number) <= 60_000);
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) throw new Error("invalid_args");
  const path = process.argv[2]!;
  const lexical = await lstat(path);
  if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size < 2 || lexical.size > MAX_EVIDENCE_BYTES) throw new Error("invalid_file");
  const handle = await open(path, "r");
  let raw: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== lexical.dev || stat.ino !== lexical.ino || stat.size !== lexical.size || stat.size > MAX_EVIDENCE_BYTES) throw new Error("invalid_file");
    raw = await handle.readFile("utf8");
  } finally { await handle.close(); }
  const value: unknown = JSON.parse(raw);
  if (raw !== `${JSON.stringify(value, null, 2)}\n`) throw new Error("non_canonical_json");
  if (!verifyTailnetEvidence(value, await computeTailnetEvidenceDigests())) throw new Error("invalid_evidence");
  process.stdout.write("tailnet_evidence_valid\n");
}

function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function lowerSha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function canonicalIso(value: unknown): value is string { if (typeof value !== "string") return false; const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean { const keys = Object.keys(value).sort(); return keys.length === expected.length && keys.every((key, index) => key === expected[index]); }
function orderedKeys(value: Record<string, unknown>, expected: string[]): boolean { const keys = Object.keys(value); return keys.length === expected.length && keys.every((key, index) => key === expected[index]); }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(() => { process.stderr.write("tailnet_evidence_invalid\n"); process.exitCode = 1; });

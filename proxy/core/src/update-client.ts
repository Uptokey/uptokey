import { resolve } from "node:path";
import { dataDir } from "./paths.ts";
import { stageUpdateArtifact, verifySignedUpdateManifest } from "./update-download.ts";
import { compiledUpdateOrigin, compiledUpdateTrust, type CompiledUpdateTrust } from "./update-trust.ts";
import { UpdateJournal, type UpdateTransaction } from "./update-transaction.ts";
import type { UpdatePlatform } from "./update-manifest.ts";
import { claimUpdateHelperLock } from "./update-helper-lock.ts";
import { cancelStream } from "./stream-lifecycle.ts";
import { createDeadline } from "./deadline.ts";

export async function checkAndStageUpdate(options: { currentVersion: string; platform?: NodeJS.Platform; origin?: string; trust?: CompiledUpdateTrust; fetchImpl?: typeof fetch; stagingRoot?: string; journal?: UpdateJournal; requestTimeoutMs?: number }): Promise<{ transaction: UpdateTransaction; artifactPath: string }> {
  const platform = desktopPlatform(options.platform ?? process.platform); const origin = options.origin ?? compiledUpdateOrigin(); const trust = options.trust ?? compiledUpdateTrust(); const fetchImpl = options.fetchImpl ?? fetch; const journal = options.journal ?? new UpdateJournal();
  const release = claimUpdateHelperLock(journal.location);
  try {
    const requestTimeoutMs = safeTimeout(options.requestTimeoutMs ?? 30_000);
    const existing = await journal.load(); if (existing && !["healthy", "rolled-back", "failed"].includes(existing.state)) throw new Error("update_transaction_already_active");
    const manifestUrl = `${origin}/update-manifest.json`; const signatureUrl = `${origin}/update-manifest.sig`;
    const manifestBytes = await fetchBounded(manifestUrl, "application/json", 131_072, fetchImpl, requestTimeoutMs); const signatureBytes = await fetchBounded(signatureUrl, "text/plain", 256, fetchImpl, requestTimeoutMs);
    const signature = signatureBytes.toString("utf8").trim(); const verified = verifySignedUpdateManifest(manifestBytes, signature, options.currentVersion, origin, trust); const artifact = verified.manifest.artifacts.find((item) => item.platform === platform); if (!artifact) throw new Error("update_artifact_platform_missing");
    const stagingDirectory = resolve(options.stagingRoot ?? resolve(dataDir(), "updates"), verified.manifest.version); const artifactPath = await stageUpdateArtifact({ manifest: verified.manifest, platform, stagingDirectory, fetchImpl, requestTimeoutMs });
    const transaction = await journal.begin({ platform, fromVersion: options.currentVersion, toVersion: verified.manifest.version, artifactName: artifact.path, artifactPath, artifactSha256: artifact.sha256 }); return { transaction, artifactPath };
  } finally { release(); }
}

async function fetchBounded(url: string, accept: string, maximum: number, fetchImpl: typeof fetch, requestTimeoutMs: number): Promise<Buffer> {
  const deadline = createDeadline(requestTimeoutMs); const signal = deadline.signal; let response: Response;
  try { response = await fetchImpl(url, { redirect: "manual", headers: { Accept: accept }, signal }); }
  catch { deadline.clear(); throw new Error(signal.aborted ? "update_metadata_timeout" : "update_metadata_unavailable"); }
  try {
    if (response.status !== 200 || !response.body) { cancelStream(response.body); throw new Error(response.status >= 300 && response.status < 400 ? "update_metadata_redirect_forbidden" : "update_metadata_download_failed"); }
    if (response.url !== url) { cancelStream(response.body); throw new Error("update_metadata_url_mismatch"); }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== accept) { cancelStream(response.body); throw new Error("update_metadata_content_type_invalid"); }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { cancelStream(response.body); throw new Error("update_metadata_size_invalid"); }
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!value?.byteLength) continue; size += value.byteLength; if (size > maximum) { cancelStream(reader); throw new Error("update_metadata_size_limit"); } chunks.push(Buffer.from(value)); } }
    catch (error) { if (signal.aborted) throw new Error("update_metadata_timeout"); if (error instanceof Error && error.message === "update_metadata_size_limit") throw error; throw new Error("update_metadata_unavailable"); }
    if (size === 0) throw new Error("update_metadata_empty"); return Buffer.concat(chunks, size);
  } finally { deadline.clear(); }
}
function desktopPlatform(platform: NodeJS.Platform): UpdatePlatform { if (platform === "darwin") return "macos"; if (platform === "win32") return "windows"; throw new Error("update_managed_by_package_manager_on_linux"); }
function safeTimeout(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new Error("update_timeout_invalid"); return value; }

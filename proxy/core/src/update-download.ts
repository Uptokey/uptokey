import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseUpdateManifest, assertUpdateEligible, validateUpdateManifest, type UpdateArtifact, type UpdateManifest, type UpdatePlatform } from "./update-manifest.ts";
import { verifyUpdateSignatureContent } from "../scripts/update-signature-evidence.mjs";
import { compiledUpdateTrust, type CompiledUpdateTrust } from "./update-trust.ts";
import { cancelStream } from "./stream-lifecycle.ts";
import { createDeadline } from "./deadline.ts";

export interface VerifiedUpdate { manifest: UpdateManifest; keyFingerprint: string }

export function verifySignedUpdateManifest(manifestBytes: Buffer, signature: string, currentVersion: string, expectedOrigin: string, trust: CompiledUpdateTrust = compiledUpdateTrust()): VerifiedUpdate {
  const fallback = trust.fallbackKeys ?? []; if (fallback.length > 1 || fallback.some((candidate) => candidate.fingerprint === trust.fingerprint)) throw new Error("update_trust_set_invalid");
  let verified; let lastError; for (const candidate of [trust, ...fallback]) { try { const result = verifyUpdateSignatureContent(manifestBytes, signature.trim(), candidate.publicKey); if (result.keyFingerprint !== candidate.fingerprint) throw new Error("update_signer_not_pinned"); verified = result; break; } catch (error) { lastError = error; } } if (!verified) throw lastError instanceof Error && /encoding|length/.test(lastError.message) ? lastError : new Error("update_signer_not_pinned");
  const manifest = parseUpdateManifest(manifestBytes, expectedOrigin); assertUpdateEligible(manifest, currentVersion);
  return { manifest, keyFingerprint: verified.keyFingerprint };
}

export async function stageUpdateArtifact(options: {
  manifest: UpdateManifest; platform: UpdatePlatform; stagingDirectory: string; fetchImpl?: (input: string, init: RequestInit) => Promise<Response>; requestTimeoutMs?: number;
}): Promise<string> {
  try { return await stageUpdateArtifactInternal(options); }
  catch (error) { if (controlledStageFailure(error)) throw error; throw new Error("update_staging_unavailable"); }
}

async function stageUpdateArtifactInternal(options: {
  manifest: UpdateManifest; platform: UpdatePlatform; stagingDirectory: string; fetchImpl?: (input: string, init: RequestInit) => Promise<Response>; requestTimeoutMs?: number;
}): Promise<string> {
  const manifestErrors = validateUpdateManifest(options.manifest); if (manifestErrors.length) throw new Error(`update_manifest_rejected:${manifestErrors.join(",")}`);
  const artifact = options.manifest.artifacts.find((item) => item.platform === options.platform);
  if (!artifact) throw new Error("update_artifact_platform_missing");
  await mkdir(options.stagingDirectory, { recursive: true, mode: 0o700 });
  const lexical = await lstat(options.stagingDirectory); if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error("update_staging_path_unsafe");
  const staging = await realpath(options.stagingDirectory);
  if (!(await lstat(staging)).isDirectory()) throw new Error("update_staging_not_directory");
  const temporary = resolve(staging, `.${artifact.path}.${process.pid}.${randomUUID()}.partial`);
  const finalPath = resolve(staging, artifact.path);
  if (!within(staging, temporary) || !within(staging, finalPath)) throw new Error("update_staging_path_invalid");
  if (await verifiedExistingArtifact(finalPath, artifact)) return finalPath;

  const timeout = options.requestTimeoutMs ?? 30_000; if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error("update_timeout_invalid"); const deadline = createDeadline(timeout); const signal = deadline.signal; let response: Response;
  try { response = await (options.fetchImpl ?? fetch)(artifact.url, { redirect: "manual", headers: { Accept: "application/octet-stream" }, signal }); }
  catch { deadline.clear(); throw new Error(signal.aborted ? "update_download_timeout" : "update_download_unavailable"); }
  try {
    if (response.status !== 200 || !response.body) { cancelStream(response.body); throw new Error(response.status >= 300 && response.status < 400 ? "update_redirect_forbidden" : "update_download_failed"); }
    if (response.url && response.url !== artifact.url) { cancelStream(response.body); throw new Error("update_response_url_mismatch"); }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== artifact.size)) { cancelStream(response.body); throw new Error("update_content_length_mismatch"); }
    try { return await writeVerified(response.body, artifact, temporary, finalPath); }
    catch (error) { if (signal.aborted) throw new Error("update_download_timeout"); if (error instanceof Error && ["update_size_limit_exceeded", "update_size_mismatch", "update_digest_mismatch"].includes(error.message)) throw error; throw new Error("update_download_unavailable"); }
  } finally { deadline.clear(); }
}

async function writeVerified(body: ReadableStream<Uint8Array>, artifact: UpdateArtifact, temporary: string, finalPath: string): Promise<string> {
  const file = await open(temporary, "wx", 0o600); const reader = body.getReader(); const hash = createHash("sha256"); let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) continue;
      size += value.byteLength; if (size > artifact.size) { cancelStream(reader); throw new Error("update_size_limit_exceeded"); }
      hash.update(value); await file.write(value);
    }
    if (size !== artifact.size) throw new Error("update_size_mismatch");
    if (hash.digest("hex") !== artifact.sha256) throw new Error("update_digest_mismatch");
    await file.sync(); await file.close(); await link(temporary, finalPath); await syncStagingDirectory(resolve(finalPath, "..")); await rm(temporary).catch(() => undefined); return finalPath;
  } catch (error) { cancelStream(reader); await file.close().catch(() => undefined); await rm(temporary, { force: true }); throw error; }
}

async function syncStagingDirectory(path: string): Promise<void> { if (process.platform === "win32") return; const directory = await open(path, "r"); try { await directory.sync(); } finally { await directory.close(); } }

async function verifiedExistingArtifact(path: string, artifact: UpdateArtifact): Promise<boolean> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("update_staged_artifact_conflict");
  if (metadata.size !== artifact.size) { await rm(path); return false; }
  const hash = createHash("sha256"); let observed = 0;
  for await (const chunk of createReadStream(path)) { observed += chunk.length; if (observed > artifact.size) break; hash.update(chunk); }
  if (observed !== artifact.size || hash.digest("hex") !== artifact.sha256) { await rm(path); return false; }
  return true;
}

function within(root: string, candidate: string): boolean { return candidate.startsWith(`${root}\\`) || candidate.startsWith(`${root}/`); }
function controlledStageFailure(error: unknown): error is Error {
  return error instanceof Error && /^update_(?:manifest_rejected(?::[a-z0-9_,.-]+)?|artifact_platform_missing|timeout_invalid|staging_path_unsafe|staging_not_directory|staging_path_invalid|staged_artifact_conflict|download_timeout|download_unavailable|redirect_forbidden|download_failed|response_url_mismatch|content_length_mismatch|size_limit_exceeded|size_mismatch|digest_mismatch)$/.test(error.message);
}

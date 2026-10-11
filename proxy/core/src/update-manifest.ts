import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";

export type UpdatePlatform = "macos" | "windows" | "linux";
export interface UpdateArtifact { platform: UpdatePlatform; path: string; url: string; sha256: string; size: number }
export interface UpdateManifest { schema: "uptokey-update-manifest-v1"; version: string; minimumVersion: string; publishedAt: string; checksumsSha256: string; artifacts: UpdateArtifact[] }

export function parseUpdateManifest(input: string | Buffer, expectedOrigin?: string): UpdateManifest {
  const value = JSON.parse(String(input)) as UpdateManifest;
  const errors = validateUpdateManifest(value, expectedOrigin);
  if (errors.length) throw new Error(errors.join(","));
  return value;
}

export function validateUpdateManifest(value: UpdateManifest, expectedOrigin?: string): string[] {
  const errors: string[] = [];
  if (!record(value) || Object.keys(value).sort().join(",") !== "artifacts,checksumsSha256,minimumVersion,publishedAt,schema,version") errors.push("update_manifest_shape_invalid");
  if (value?.schema !== "uptokey-update-manifest-v1") errors.push("update_manifest_schema_invalid");
  const versionValid = validUpdateVersion(value?.version); const minimumValid = validUpdateVersion(value?.minimumVersion);
  if (!versionValid) errors.push("update_manifest_version_invalid");
  if (!minimumValid || versionValid && compareVersions(value.minimumVersion, value.version) > 0) errors.push("update_manifest_minimum_version_invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value?.publishedAt ?? "") || !Number.isFinite(Date.parse(value?.publishedAt ?? ""))) errors.push("update_manifest_published_at_invalid");
  if (!/^[a-f0-9]{64}$/.test(value?.checksumsSha256 ?? "")) errors.push("update_manifest_checksums_digest_invalid");
  if (!Array.isArray(value?.artifacts) || value.artifacts.length < 1) errors.push("update_manifest_no_artifacts");
  else if (value.artifacts.length > 3) errors.push("update_manifest_too_many_artifacts");
  const platforms = new Set<UpdatePlatform>(); const origins = new Set<string>();
  for (const artifact of value?.artifacts ?? []) {
    if (!record(artifact) || Object.keys(artifact).sort().join(",") !== "path,platform,sha256,size,url") errors.push("update_manifest_artifact_shape_invalid");
    if (!(["macos", "windows", "linux"] as string[]).includes(artifact?.platform) || platforms.has(artifact.platform)) errors.push("update_manifest_platform_invalid_or_duplicate");
    else platforms.add(artifact.platform);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifact?.path ?? "")) errors.push("update_manifest_artifact_path_invalid");
    if (!/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? "")) errors.push("update_manifest_artifact_digest_invalid");
    if (!Number.isSafeInteger(artifact?.size) || artifact.size <= 0 || artifact.size > 2_147_483_648) errors.push("update_manifest_artifact_size_invalid");
    try {
      const url = new URL(artifact.url); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname.split("/").at(-1) !== artifact.path) errors.push("update_manifest_artifact_url_invalid");
      origins.add(url.origin); if (expectedOrigin && url.origin !== expectedOrigin) errors.push("update_manifest_origin_mismatch");
    } catch { errors.push("update_manifest_artifact_url_invalid"); }
  }
  if (origins.size !== 1) errors.push("update_manifest_multiple_origins_forbidden");
  return [...new Set(errors)];
}

export function assertUpdateEligible(manifest: UpdateManifest, currentVersion: string): void {
  if (!validUpdateVersion(currentVersion)) throw new Error("current_version_invalid");
  if (compareVersions(manifest.version, currentVersion) <= 0) throw new Error("update_rollback_or_reinstall_forbidden");
  if (compareVersions(currentVersion, manifest.minimumVersion) < 0) throw new Error("update_manual_upgrade_required");
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left); const b = parseVersion(right);
  for (const index of [0, 1, 2] as const) if (a[index] !== b[index]) return a[index] - b[index];
  return comparePrerelease(a[3], b[3]);
}

export function validUpdateVersion(value: string): boolean { const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value ?? ""); return !!match && value.length <= 100 && match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part))) && (!match[4] || match[4].split(".").every((part) => !/^\d+$/.test(part) || /^(?:0|[1-9]\d*)$/.test(part))); }
function parseVersion(value: string): [number, number, number, string | undefined] { if (!validUpdateVersion(value)) throw new Error("version_invalid"); const match = /^v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value)!; return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]]; }
function comparePrerelease(a?: string, b?: string): number {
  if (a === b) return 0; if (!a) return 1; if (!b) return -1;
  const left = a.split("."); const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index], y = right[index]; if (x === undefined) return -1; if (y === undefined) return 1; if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y); if (xn && !yn) return -1; if (!xn && yn) return 1;
    if (xn && yn) return x.length === y.length ? (x < y ? -1 : 1) : x.length - y.length;
    return x < y ? -1 : 1;
  }
  return 0;
}

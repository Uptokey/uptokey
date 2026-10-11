import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve, sep, parse } from "node:path";
import type { SkillManifest as W0SkillManifest, SkillInstallState as W0SkillInstallState } from "@uptokey/sync-contract/agents-cli";

/** Re-export canonical W0 types for backward compatibility. */
export type SkillInstallState = W0SkillInstallState;
export type SkillManifest = Omit<W0SkillManifest, "schemaVersion">;

export interface SkillPackageFixture {
  id: string;
  revision: string;
  license: string;
  sourceUrl: string;
  entrypoint: string;
  files: Array<{ path: string; content: string }>;
  dependencies?: string[];
  allowedCapabilities?: string[];
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertSafeRelative(path: string): void {
  if (!path || path.includes("\0") || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    throw Object.assign(new Error("install_target_denied"), { code: "install_target_denied" });
  }
  if (path.split(/[/\\]/).some((p) => p === ".." || p === "")) {
    throw Object.assign(new Error("install_target_denied"), { code: "install_target_denied" });
  }
}

async function assertNoLinks(path:string){
  const absolute=resolve(path),volume=parse(absolute).root;let cursor=volume;
  for(const part of absolute.slice(volume.length).split(sep).filter(Boolean)){
    cursor=join(cursor,part);
    try{const stat=await lstat(cursor);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw Object.assign(new Error('install_target_denied'),{code:'install_target_denied'});}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}
  }
}

export function buildSkillManifest(pkg: SkillPackageFixture): SkillManifest {
  if (!/^https:\/\//.test(pkg.sourceUrl) && !/^fixture:\/\//.test(pkg.sourceUrl)) {
    throw Object.assign(new Error("skill_source_invalid"), { code: "client_config_invalid" });
  }
  const files = pkg.files.map((f) => {
    assertSafeRelative(f.path);
    const buf = Buffer.from(f.content, "utf8");
    return { path: f.path.replace(/\\/g, "/"), sha256: sha256(buf), bytes: buf.length };
  });
  return {
    id: pkg.id,
    sourceUrl: pkg.sourceUrl,
    revision: pkg.revision,
    license: pkg.license,
    files,
    entrypoint: pkg.entrypoint,
    dependencies: [...(pkg.dependencies ?? [])],
    allowedCapabilities: [...(pkg.allowedCapabilities ?? ["read"])],
    state: "available",
    grantsExecution: false,
    instructionsTrusted: false,
  };
}

export interface InstallPreview {
  manifest: SkillManifest;
  conflicts: Array<{ path: string; existingSha256: string; incomingSha256: string }>;
  wouldWrite: string[];
}

export async function previewSkillInstall(targetRoot: string, pkg: SkillPackageFixture): Promise<InstallPreview> {
  const manifest = buildSkillManifest(pkg);
  const root = resolve(targetRoot);
  await assertNoLinks(root);
  const conflicts: InstallPreview["conflicts"] = [];
  const wouldWrite: string[] = [];
  for (const file of manifest.files) {
    const dest = resolve(root, file.path);
    await assertNoLinks(dest);
    if (!dest.startsWith(root + sep) && dest !== root) {
      throw Object.assign(new Error("install_target_denied"), { code: "install_target_denied" });
    }
    wouldWrite.push(file.path);
    try {
      const existing = await readFile(dest);
      const existingSha = sha256(existing);
      if (existingSha !== file.sha256) conflicts.push({ path: file.path, existingSha256: existingSha, incomingSha256: file.sha256 });
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    }
  }
  return { manifest, conflicts, wouldWrite };
}

export async function installSkillPackage(
  targetRoot: string,
  pkg: SkillPackageFixture,
  options: { replaceConflicts?: boolean; expectedIntegrity?: Record<string, string> } = {},
): Promise<{ manifest: SkillManifest; receiptId: string; written: string[] }> {
  const preview = await previewSkillInstall(targetRoot, pkg);
  if (preview.conflicts.length > 0 && !options.replaceConflicts) {
    throw Object.assign(new Error("install_conflict"), { code: "install_conflict", conflicts: preview.conflicts });
  }
  if (options.expectedIntegrity) {
    for (const file of preview.manifest.files) {
      const expected = options.expectedIntegrity[file.path];
      if (expected && expected !== file.sha256) {
        throw Object.assign(new Error("package_integrity_failed"), { code: "package_integrity_failed" });
      }
    }
  } else if (!pkg.files.length) {
    throw Object.assign(new Error("package_integrity_failed"), { code: "package_integrity_failed" });
  }

  const root = resolve(targetRoot);
  const written: string[] = [];
  for (const file of pkg.files) {
    assertSafeRelative(file.path);
    const dest = resolve(root, file.path);
    await assertNoLinks(dest);
    if (!dest.startsWith(root + sep) && dest !== join(root, file.path)) {
      // harden
      if (!dest.startsWith(root)) throw Object.assign(new Error("install_target_denied"), { code: "install_target_denied" });
    }
    await mkdir(resolve(dest, ".."), { recursive: true });
    await writeFile(dest, file.content, "utf8");
    written.push(file.path);
  }
  const manifestPath = join(root, ".uptokey-skill-manifest.json");
  await assertNoLinks(manifestPath);
  const installed: SkillManifest = { ...preview.manifest, state: "installed" };
  await writeFile(manifestPath, JSON.stringify(installed, null, 2) + "\n", "utf8");
  return { manifest: installed, receiptId: `skill_${randomBytes(8).toString("hex")}`, written };
}

export async function loadInstalledManifest(targetRoot: string): Promise<SkillManifest | null> {
  await assertNoLinks(join(resolve(targetRoot), ".uptokey-skill-manifest.json"));
  try {
    const raw = await readFile(join(resolve(targetRoot), ".uptokey-skill-manifest.json"), "utf8");
    return JSON.parse(raw) as SkillManifest;
  } catch {
    return null;
  }
}

/** Rollback: remove only files whose hash still matches manifest. */
export async function uninstallSkillByManifest(targetRoot: string): Promise<{ removed: string[]; skippedChanged: string[] }> {
  const manifest = await loadInstalledManifest(targetRoot);
  if (!manifest) return { removed: [], skippedChanged: [] };
  const root = resolve(targetRoot);
  const removed: string[] = [];
  const skippedChanged: string[] = [];
  for (const file of manifest.files) {
    assertSafeRelative(file.path);
    const dest = resolve(root, file.path);
    await assertNoLinks(dest);
    try {
      const current = sha256(await readFile(dest));
      if (current !== file.sha256) {
        skippedChanged.push(file.path);
        continue;
      }
      const { unlink } = await import("node:fs/promises");
      await unlink(dest);
      removed.push(file.path);
    } catch {
      /* already gone */
    }
  }
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(join(root, ".uptokey-skill-manifest.json"));
  } catch { /* */ }
  return { removed, skippedChanged };
}

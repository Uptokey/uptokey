import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { InstallPlan as W0InstallPlan, InstallManifest as W0InstallManifest } from "@uptokey/sync-contract/agents-cli";

/** Re-export canonical W0 types for backward compatibility. */
export type InstallPlan = Omit<W0InstallPlan, "schemaVersion">;
export type InstallManifest = Omit<W0InstallManifest, "schemaVersion">;

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertSafe(path: string): void {
  if (!path || path.includes("..") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw Object.assign(new Error("install_target_denied"), { code: "install_target_denied" });
  }
}

export function createInstallPlan(input: {
  packageOrigin: string;
  exactVersion: string;
  integrity: string;
  targetRootRef: string;
  managerProfile: InstallPlan["managerProfile"];
  files: Array<{ path: string; content: string }>;
}): InstallPlan {
  if (!input.exactVersion || !input.integrity) {
    throw Object.assign(new Error("package_integrity_failed"), { code: "package_integrity_failed" });
  }
  if (input.managerProfile !== "fixture" && input.managerProfile !== "npm" && input.managerProfile !== "npx" && input.managerProfile !== "pip") {
    throw Object.assign(new Error("install_target_denied"), { code: "install_target_denied" });
  }
  const expectedFiles = input.files.map((f) => {
    assertSafe(f.path);
    return { path: f.path, sha256: sha256(f.content) };
  });
  const material = expectedFiles.map((f) => `${f.path}:${f.sha256}`).join("|");
  const integrity = input.integrity === "auto" ? sha256(material) : input.integrity;
  if (integrity !== sha256(material)) {
    throw Object.assign(new Error("package_integrity_failed"), { code: "package_integrity_failed" });
  }
  return {
    id: `plan_${randomBytes(6).toString("hex")}`,
    packageOrigin: input.packageOrigin,
    exactVersion: input.exactVersion,
    integrity,
    targetRootRef: input.targetRootRef,
    managerProfile: input.managerProfile,
    lifecyclePolicy: "scripts_denied",
    expectedFiles,
  };
}

export async function applyInstallPlan(
  plan: InstallPlan,
  files: Array<{ path: string; content: string }>,
  options: { signal?: AbortSignal; spawned?: boolean } = {},
): Promise<InstallManifest> {
  if (options.signal?.aborted && !options.spawned) {
    throw Object.assign(new Error("session_revoked"), { code: "session_revoked", stage: "before_spawn", effect: "not_sent" });
  }
  const root = resolve(plan.targetRootRef);
  const written: string[] = [];
  for (const file of files) {
    if (options.signal?.aborted && options.spawned) {
      return {
        planId: plan.id,
        origin: plan.packageOrigin,
        revision: plan.exactVersion,
        integrity: plan.integrity,
        written,
        receiptId: `rcpt_${randomBytes(6).toString("hex")}`,
      };
    }
    assertSafe(file.path);
    const expected = plan.expectedFiles.find((e) => e.path === file.path);
    if (!expected || expected.sha256 !== sha256(file.content)) {
      throw Object.assign(new Error("package_integrity_failed"), { code: "package_integrity_failed" });
    }
    const dest = resolve(root, file.path);
    if (!dest.startsWith(root + sep) && dest !== join(root, file.path)) {
      if (!dest.startsWith(root)) throw Object.assign(new Error("install_target_denied"), { code: "install_target_denied" });
    }
    await mkdir(resolve(dest, ".."), { recursive: true });
    await writeFile(dest, file.content, "utf8");
    written.push(file.path);
  }
  const manifest: InstallManifest = {
    planId: plan.id,
    origin: plan.packageOrigin,
    revision: plan.exactVersion,
    integrity: plan.integrity,
    written,
    receiptId: `rcpt_${randomBytes(6).toString("hex")}`,
  };
  await writeFile(join(root, ".uptokey-install-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

export async function reloadInstallManifest(targetRoot: string): Promise<InstallManifest | null> {
  try {
    return JSON.parse(await readFile(join(resolve(targetRoot), ".uptokey-install-manifest.json"), "utf8")) as InstallManifest;
  } catch {
    return null;
  }
}

export class SessionIsolationGate {
  private readonly revoked = new Set<string>();
  private readonly sessions: Map<string, { principalId: string; cwd: string }>;
  constructor(sessions: Map<string, { principalId: string; cwd: string }>) {
    this.sessions = sessions;
  }
  revoke(sessionId: string): void {
    this.revoked.add(sessionId);
  }
  assertCallable(sessionId: string, principalId: string, cwd: string): void {
    if (this.revoked.has(sessionId)) throw Object.assign(new Error("session_revoked"), { code: "session_revoked" });
    const s = this.sessions.get(sessionId);
    if (!s || s.principalId !== principalId || s.cwd !== cwd) {
      throw Object.assign(new Error("session_revoked"), { code: "session_revoked", reason: "cross_identity" });
    }
  }
}
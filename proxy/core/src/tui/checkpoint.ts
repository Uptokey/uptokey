/**
 * Creates Git snapshots for affected files before edits.
 * Restore plans preview per-path changes and require a confirmed apply
 * after recording a durable safety snapshot.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Checkpoint {
  id: string;
  ref: string;
  timestamp: number;
  operation: string;
  files: string[];
}

export interface CheckpointOptions {
  cwd: string;
  operation: string;
  files?: string[];
}

export type RestoreFileStatus = "modified" | "restorable" | "new-since";

export interface RestorePlan {
  checkpoint: Checkpoint;
  /** Durable safety snapshot recorded before any write. */
  safetyRef: string;
  files: Array<{ path: string; status: RestoreFileStatus }>;
  /** Affected files that also carry uncommitted working-tree changes. */
  conflicts: string[];
}

/**
 * Create a checkpoint before AI changes.
 * Uses `git stash create` to snapshot without modifying working tree.
 * Falls back to HEAD if the tree is clean.
 */
export async function createCheckpoint(opts: CheckpointOptions): Promise<Checkpoint | null> {
  const { cwd, operation } = opts;

  try {
    // Check if we're in a git repo
    await exec("git", ["rev-parse", "--git-dir"], { cwd });
  } catch {
    return null; // Not a git repo — skip silently
  }

  const id = `uptokey-cp-${Date.now()}`;
  let ref: string;

  try {
    // Create a stash-like object without modifying working tree
    const { stdout: stashRef } = await exec("git", ["stash", "create", `[uptokey] ${operation}`], { cwd });
    ref = stashRef.trim();

    if (!ref) {
      // Working tree is clean — use HEAD as checkpoint
      const { stdout: headRef } = await exec("git", ["rev-parse", "HEAD"], { cwd });
      ref = headRef.trim();
    }

    // Create a ref so it won't be garbage collected
    await exec("git", ["update-ref", `refs/uptokey/${id}`, ref], { cwd });

    // Get affected files
    const { stdout: diffOutput } = await exec(
      "git", ["diff", "--name-only", "HEAD"],
      { cwd },
    );
    const files = opts.files ?? diffOutput.trim().split("\n").filter(Boolean);

    return { id, ref, timestamp: Date.now(), operation, files };
  } catch {
    return null;
  }
}

/**
 * Build a previewed restore plan for a checkpoint.
 * Never touches the working tree; records the safety ref first so the
 * current state is always recoverable even after a later apply.
 */
export async function planRestore(cwd: string, checkpoint: Checkpoint): Promise<RestorePlan | null> {
  try {
    await exec("git", ["rev-parse", "--git-dir"], { cwd });

    // Durable safety snapshot: stash-like object pinned with update-ref.
    const { stdout: stashRef } = await exec("git", ["stash", "create", "[uptokey] pre-restore"], { cwd });
    const safetyTarget = stashRef.trim()
      || (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    const safetyId = `pre-restore-${Date.now()}`;
    await exec("git", ["update-ref", `refs/uptokey/${safetyId}`, safetyTarget], { cwd });

    // Files that differ between the checkpoint and current HEAD.
    const { stdout } = await exec("git", ["diff", "--name-status", checkpoint.ref, "HEAD"], { cwd });
    const files: RestorePlan["files"] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [status, ...rest] = trimmed.split(/\s+/);
      const path = rest.join(" ");
      if (!path) continue;
      if (status === "D") {
        // Existed at the checkpoint, deleted since: restorable.
        files.push({ path, status: "restorable" });
      } else if (status === "A") {
        // Created after the checkpoint: never touched by a restore.
        files.push({ path, status: "new-since" });
      } else {
        files.push({ path, status: "modified" });
      }
    }

    // Uncommitted working-tree changes over the affected files are conflicts.
    const { stdout: dirty } = await exec("git", ["diff", "--name-only", "HEAD"], { cwd });
    const dirtySet = new Set(dirty.split("\n").map((l) => l.trim()).filter(Boolean));
    const conflicts = files
      .filter((f) => f.status !== "new-since" && dirtySet.has(f.path))
      .map((f) => f.path);

    return { checkpoint, safetyRef: `refs/uptokey/${safetyId}`, files, conflicts };
  } catch {
    return null;
  }
}

/**
 * Apply a previously previewed restore plan.
 * Only paths present at the checkpoint are checked out, per-path; files
 * created after the checkpoint are never deleted or touched.
 */
export async function applyRestore(
  cwd: string,
  plan: RestorePlan,
): Promise<{ restored: string[]; failed: string[] }> {
  const targets = plan.files
    .filter((f) => f.status === "modified" || f.status === "restorable")
    .map((f) => f.path);

  const restored: string[] = [];
  const failed: string[] = [];
  const batchSize = 20;
  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    try {
      await exec("git", ["checkout", plan.checkpoint.ref, "--", ...batch], { cwd });
      restored.push(...batch);
    } catch {
      // Fall back to per-path so one bad path does not sink the batch.
      for (const path of batch) {
        try {
          await exec("git", ["checkout", plan.checkpoint.ref, "--", path], { cwd });
          restored.push(path);
        } catch {
          failed.push(path);
        }
      }
    }
  }
  return { restored, failed };
}

/**
 * Deprecated direct rollback: kept only for compatibility. Refuses to run
 * without an explicit `confirmed: true`; the governed path is
 * planRestore + applyRestore (preview + consent).
 */
export async function rollbackToCheckpoint(
  cwd: string,
  checkpoint: Checkpoint,
  options?: { confirmed?: boolean },
): Promise<boolean> {
  if (options?.confirmed !== true) return false;
  const plan = await planRestore(cwd, checkpoint);
  if (!plan) return false;
  const { failed } = await applyRestore(cwd, plan);
  return failed.length === 0;
}

/**
 * List all uptokey checkpoints for the current repo.
 */
export async function listCheckpoints(cwd: string): Promise<Checkpoint[]> {
  try {
    const { stdout } = await exec(
      "git", ["for-each-ref", "--sort=-creatordate", "--format=%(refname:short) %(objectname:short) %(creatordate:unix)", "refs/uptokey/"],
      { cwd },
    );

    return stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [refName, objectName, ts] = line.split(" ");
      return {
        id: refName?.replace("uptokey/", "") ?? "",
        ref: objectName ?? "",
        timestamp: parseInt(ts ?? "0", 10) * 1000,
        operation: "checkpoint",
        files: [],
      };
    });
  } catch {
    return [];
  }
}

/**
 * Clean up old checkpoints (keep last N).
 */
export async function pruneCheckpoints(cwd: string, keepLast: number = 20): Promise<number> {
  const all = await listCheckpoints(cwd);
  const toDelete = all.slice(keepLast);
  let deleted = 0;

  for (const cp of toDelete) {
    try {
      await exec("git", ["update-ref", "-d", `refs/uptokey/${cp.id}`], { cwd });
      deleted++;
    } catch {
      // ignore
    }
  }

  return deleted;
}

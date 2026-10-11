/**
 * C6 — harness orchestration: localizer → patcher → validator → report.
 *
 * Per task, in a throwaway sandbox copy of the task repository:
 *   1. localize   (A10 repo graph + PageRank; optional A14 architect)
 *   2. patch      (A14 coder prompts over SEARCH/REPLACE; reflection via repair)
 *   3. validate   (injected runner; repair loop with the failing output)
 *   4. report     (SWE-Bench evaluator-compatible predictions + summary)
 *
 * No effect ever reaches the user's worktree or the dataset source. The
 * runner is injected: synthetic rounds run locally for free; a governed round
 * against the real SWE-Bench Verified binds the canonical OCI runner and only
 * happens with explicit approval and budget (500 tasks ≈ US$ 40–80).
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoGraph } from "../repo-graph.ts";
import { localize } from "./localizer.ts";
import { patch, type CoderCall, type SnapshotReader, type TokenUsage } from "./patcher.ts";
import { validate, type PatchRunner } from "./validator.ts";
import { loadDataset, type DatasetName, type SweTask } from "./dataset-loader.ts";
import { generateReport, summarizePatch, type SweBenchReport, type TaskResult } from "./report.ts";

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export interface HarnessConfig {
  dataset: DatasetName;
  datasetDir: string;
  /** Placeholder substitution for dataset `repo_path` templates. */
  replace?: Record<string, string>;
  /** Max tasks (default all in the file). */
  tasks?: number;
  coderModel: string;
  architectModel: string;
  /** A14 architect transport; absent = lexical localization only. */
  architect?: (prompt: string) => Promise<string>;
  /** A14 coder transport. Receives the issue plus the failing output on repair. */
  coder: CoderCall;
  runner: PatchRunner;
  /** How many repair re-prompts after a failing validation (default 3). */
  maxRepairAttempts?: number;
  /** Keep sandboxes for inspection (default false; always under the OS temp dir). */
  keepSandbox?: boolean;
}

export async function runSweBench(config: HarnessConfig): Promise<SweBenchReport> {
  const tasks: SweTask[] = await loadDataset({
    dir: config.datasetDir,
    dataset: config.dataset,
    tasks: config.tasks,
    replace: config.replace,
  });

  const results: TaskResult[] = [];
  for (const task of tasks) {
    const startedAt = Date.now();
    let usage: TokenUsage = ZERO;
    let localizedFiles: string[] = [];
    let patchSummary: string | null = null;
    let resolved = false;
    let validation: TaskResult["validation"] = { attempts: 0, exit: null, pass: false };

    const sandbox = await mkdtemp(join(tmpdir(), "swe-sandbox-"));
    try {
      await cp(task.repo_path, sandbox, { recursive: true });
      const graph = await buildRepoGraph(sandbox, { maxFiles: 500 });
      const localized = await localize(task.problem_statement, graph, { architect: config.architect });
      localizedFiles = localized.files;
      if (localized.files.length) {
        const read: SnapshotReader = async (path) => {
          const { readFile } = await import("node:fs/promises");
          try {
            const text = await readFile(join(sandbox, ...path.split("/")), "utf-8");
            return { text, sha256: `sha-${path}` };
          } catch {
            return { text: null, sha256: null };
          }
        };
        const buildPatch = (objective: string) => patch(objective, localized.files.slice(0, 5), read, config.coder);
        let lastPatchSet = await buildPatch(task.problem_statement);
        usage = { inputTokens: lastPatchSet.usage.inputTokens, outputTokens: lastPatchSet.usage.outputTokens };
        const outcome = await validate(lastPatchSet, sandbox, task.test_command, {
          runner: config.runner,
          maxRepairAttempts: config.maxRepairAttempts,
          repair: async (failureText) => {
            const repaired = await buildPatch(`${task.problem_statement}\n\nO patch anterior não passou na validação. Saída dos testes:\n${failureText}\n\nCorrija os blocos SEARCH/REPLACE.`);
            usage = { inputTokens: usage.inputTokens + repaired.usage.inputTokens, outputTokens: usage.outputTokens + repaired.usage.outputTokens };
            lastPatchSet = repaired;
            return repaired;
          },
        });
        patchSummary = summarizePatch(lastPatchSet);
        resolved = outcome.pass;
        validation = { attempts: outcome.attempts, exit: outcome.exit, pass: outcome.pass, ...(outcome.failureText ? { failureText: outcome.failureText } : {}) };
      } else {
        validation = { attempts: 0, exit: null, pass: false, failureText: "localization_empty" };
      }
    } catch (error) {
      validation = { attempts: validation.attempts, exit: null, pass: false, failureText: error instanceof Error ? error.message : "harness_error" };
    } finally {
      if (!config.keepSandbox) await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
    }

    results.push({
      instance_id: task.instance_id,
      resolved,
      patch: patchSummary,
      validation,
      localizedFiles,
      usage,
      durationMs: Date.now() - startedAt,
    });
  }

  return generateReport({
    dataset: config.dataset,
    coderModel: config.coderModel,
    results,
  });
}

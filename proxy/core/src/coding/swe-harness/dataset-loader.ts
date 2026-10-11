/**
 * C6 — SWE-Bench task dataset loader.
 *
 * Reads task JSONL from a local directory (`datasets/swe-bench-verified/`,
 * gitignored). There is no network anywhere: the real Verified JSONL is
 * downloaded once, manually, by the person operating the benchmark, and the
 * loader refuses to run when the file is absent. Synthetic datasets use the
 * same schema so CI never touches the network or a paid API.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type DatasetName = "verified" | "lite" | "synthetic";

export interface SweTask {
  instance_id: string;
  repo: string;
  /** Absolute or `{REPO_ROOT}`-templated path to a local copy of the repo. */
  repo_path: string;
  problem_statement: string;
  /** Command run inside the sandbox to validate the patch. */
  test_command: string;
}

const REQUIRED_KEYS = new Set(["instance_id", "repo", "repo_path", "problem_statement", "test_command"]);

export interface LoadDatasetOptions {
  /** Directory holding `<dataset>.jsonl`. */
  dir: string;
  dataset: DatasetName;
  /** Max tasks (default: all). */
  tasks?: number;
  /** Placeholder substitution, e.g. `{ "REPO_ROOT": "/abs/path" }` for `{REPO_ROOT}/repo`. */
  replace?: Record<string, string>;
}

export async function loadDataset(options: LoadDatasetOptions): Promise<SweTask[]> {
  const path = join(options.dir, `${options.dataset}.jsonl`);
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    throw new Error(`dataset_missing: ${path}. Baixe o JSONL uma vez, manualmente; o loader nunca acessa a rede.`);
  }
  const tasks: SweTask[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`dataset_line_invalid: ${path}:${index + 1}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`dataset_line_invalid: ${path}:${index + 1}`);
    const record = parsed as Record<string, unknown>;
    for (const key of REQUIRED_KEYS) {
      if (typeof record[key] !== "string" || !(record[key] as string).trim()) throw new Error(`dataset_field_missing: ${key} em ${path}:${index + 1}`);
    }
    let repoPath = record.repo_path as string;
    for (const [token, value] of Object.entries(options.replace ?? {})) {
      repoPath = repoPath.replaceAll(`{${token}}`, value);
    }
    tasks.push({
      instance_id: record.instance_id as string,
      repo: record.repo as string,
      repo_path: repoPath,
      problem_statement: record.problem_statement as string,
      test_command: record.test_command as string,
    });
  }
  if (!tasks.length) throw new Error(`dataset_empty: ${path}`);
  return options.tasks ? tasks.slice(0, options.tasks) : tasks;
}

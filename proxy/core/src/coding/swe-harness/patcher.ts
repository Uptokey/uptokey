/**
 * C6 / step 2 — repair generation per localized file (Agentless stage 2).
 *
 * The coder (A14 prompts, injected transport) receives the issue plus the
 * current file content and answers in the canonical SEARCH/REPLACE protocol.
 * Blocks are applied with the same pure engine the TUI uses (edit-blocks.ts):
 * a file whose blocks do not apply is reported, never half-written. This
 * module performs no filesystem effect — it produces candidate bytes.
 */
import { applyEditBlocks, parseEditBlocks, type AppliedFile, type ApplyFailure, type FileSnapshot } from "../../tui/edit-blocks.ts";
import { composeCoderPrompt } from "../prompts/coder.ts";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CoderCall {
  (prompt: string): Promise<{ text: string; usage?: TokenUsage }>;
}

export interface FilePatch {
  path: string;
  before: string | null;
  beforeSha256: string | null;
  after: string;
}

export interface PatchSet {
  patches: FilePatch[];
  failures: ApplyFailure[];
  blocks: number;
  usage: TokenUsage;
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: TokenUsage, b?: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + (b?.inputTokens ?? 0), outputTokens: a.outputTokens + (b?.outputTokens ?? 0) };
}

/** Current bytes per path; production read goes through the project root service. */
export type SnapshotReader = (path: string) => Promise<FileSnapshot>;

export async function patch(
  issue: string,
  files: readonly string[],
  read: SnapshotReader,
  coder: CoderCall,
): Promise<PatchSet> {
  const snapshots = new Map<string, FileSnapshot>();
  const blocks = [];
  let usage: TokenUsage = ZERO_USAGE;
  const failures: ApplyFailure[] = [];

  for (const path of files) {
    let snapshot: FileSnapshot;
    try {
      snapshot = await read(path);
    } catch (error) {
      failures.push({ path, line: 1, reason: `leitura recusada: ${error instanceof Error ? error.message : "falha"}` });
      continue;
    }
    snapshots.set(path, snapshot);
    const fileContext = snapshot.text === null
      ? `(arquivo novo: ${path} ainda não existe; use SEARCH vazio para criar)`
      : `Conteúdo atual de ${path}:\n${snapshot.text.slice(0, 40_000)}`;
    const response = await coder(composeCoderPrompt(`${fileContext}`, issue));
    usage = addUsage(usage, response.usage);
    const parsed = parseEditBlocks(response.text);
    for (const block of parsed.blocks) blocks.push(block);
    for (const rejected of parsed.rejected) {
      failures.push({ path: rejected.path ?? path, line: rejected.line, reason: rejected.reason });
    }
  }

  const applied = applyEditBlocks(blocks, snapshots);
  const patches: FilePatch[] = applied.files.map((file) => ({
    path: file.path,
    before: file.before,
    beforeSha256: file.beforeSha256,
    after: file.after,
  }));
  return { patches, failures: [...failures, ...applied.failures], blocks: blocks.length, usage };
}

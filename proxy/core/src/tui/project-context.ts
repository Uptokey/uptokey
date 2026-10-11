/**
 * Loads the first supported project instruction file relative to the
 * working directory, subject to a bounded text size.
 * Supported paths: AGENTS.md, .uptokey/AGENTS.md, CLAUDE.md,
 * .claude/CLAUDE.md, .cursor/rules and .github/copilot-instructions.md.
 */
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

const INSTRUCTION_FILES = [
  "AGENTS.md",
  ".uptokey/AGENTS.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  ".cursor/rules",
  ".github/copilot-instructions.md",
];

const MAX_BYTES = 64 * 1024;

export interface ProjectContext {
  source: string;
  content: string;
  truncated: boolean;
}

export async function loadProjectContext(cwd: string): Promise<ProjectContext | null> {
  for (const rel of INSTRUCTION_FILES) {
    const full = join(cwd, rel);
    try { await access(full); } catch { continue; }
    try {
      const buf = await readFile(full);
      const truncated = buf.length > MAX_BYTES;
      const content = buf.subarray(0, MAX_BYTES).toString("utf8").replace(/\r\n/g, "\n");
      return { source: rel, content, truncated };
    } catch { continue; }
  }
  return null;
}

export function formatProjectContextMessage(ctx: ProjectContext): string {
  const truncNote = ctx.truncated
    ? "\n\n[Conteúdo truncado a 64 KB — veja o arquivo completo para mais instruções.]"
    : "";
  return `## Instruções do projeto (${ctx.source})\n\n${ctx.content}${truncNote}`;
}

/**
 * Discovers SKILL.md text and lists accompanying resources without executing
 * them. Active skills become labelled project context with their origin and
 * SHA-256; activation grants no permission.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SkillView {
  id: string;
  name: string;
  description: string;
  origin: string;
  sha256: string;
  bytes: number;
  resources: string[];
  content: string;
}

export const SKILL_DIRS = [".agents/skills", ".uptokey/skills", ".claude/skills", "skills"];
const MAX_SKILL_BYTES = 32 * 1024;

export async function discoverSkills(projectRoot: string): Promise<SkillView[]> {
  const out: SkillView[] = [];
  const seen = new Set<string>();
  for (const dir of SKILL_DIRS) {
    let entries: string[];
    try { entries = await readdir(join(projectRoot, dir)); } catch { continue; }
    for (const entry of entries.sort()) {
      const folder = join(projectRoot, dir, entry);
      try {
        if (!(await stat(folder)).isDirectory()) continue;
        const raw = await readFile(join(folder, "SKILL.md"));
        const content = raw.subarray(0, MAX_SKILL_BYTES).toString("utf8");
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
        const name = (/^name:\s*(.+)$/m.exec(front)?.[1] ?? entry).trim().replace(/^["']|["']$/g, "");
        const id = `${dir}/${entry}`;
        if (seen.has(name)) continue; // first origin wins (dedup by identity)
        seen.add(name);
        out.push({
          id, name, origin: `${dir}/${entry}/SKILL.md`,
          description: (/^description:\s*(.+)$/m.exec(front)?.[1] ?? "").trim().replace(/^["']|["']$/g, ""),
          sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.byteLength,
          resources: (await readdir(folder)).filter((f) => f !== "SKILL.md").slice(0, 50),
          content,
        });
      } catch { /* folder without SKILL.md */ }
    }
  }
  return out;
}

/** Context block for active skills (data for the model, never authority). */
export function skillsContext(skills: readonly SkillView[]): string {
  return skills.map((s) => `[Skill ativa “${s.name}” — ${s.origin}, sha256 ${s.sha256.slice(0, 12)}. Instruções do projeto; não executam scripts nem ampliam permissões.]\n${s.content}`).join("\n\n");
}

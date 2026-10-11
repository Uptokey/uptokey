/**
 * Uptokey TUI — Skills loader and artifact manager.
 *
 * T27: Load and manage skills from project directory.
 * Skills follow the same format as AGENTS.md skills system.
 *
 * T32: Manage and reference artifacts produced during conversation.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";

// ─── Skills (T27) ────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  path: string;
  content: string;
  hash: string;
  enabled: boolean;
}

const SKILL_DIRS = [
  ".agents/skills",
  ".uptokey/skills",
  ".claude/skills",
];

/**
 * Load skills from project directories.
 */
export async function loadSkills(projectRoot: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  for (const dir of SKILL_DIRS) {
    const skillsPath = join(projectRoot, dir);
    let entries: string[];
    try { entries = await readdir(skillsPath); } catch { continue; }

    for (const entry of entries) {
      const skillDir = join(skillsPath, entry);
      const skillFile = join(skillDir, "SKILL.md");

      try {
        const st = await stat(skillDir);
        if (!st.isDirectory()) continue;

        const content = await readFile(skillFile, "utf-8");

        // Parse YAML frontmatter
        const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
        let name = entry;
        let description = "";
        if (fmMatch?.[1]) {
          const nameMatch = /^name:\s*(.+)$/m.exec(fmMatch[1]);
          const descMatch = /^description:\s*(.+)$/m.exec(fmMatch[1]);
          if (nameMatch?.[1]) name = nameMatch[1].trim();
          if (descMatch?.[1]) description = descMatch[1].trim();
        }

        // Simple hash for change detection
        const hash = simpleHash(content);

        skills.push({ name, description, path: skillFile, content, hash, enabled: true });
      } catch {
        continue;
      }
    }
  }

  return skills;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Format skills list for display.
 */
export function formatSkillsList(skills: Skill[]): string {
  if (skills.length === 0) return "Nenhuma skill encontrada em .agents/skills/ ou .uptokey/skills/";

  return skills.map((s) => {
    const status = s.enabled ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    return `  ${status} ${s.name}${s.description ? ` — ${s.description}` : ""}`;
  }).join("\n");
}

// ─── Artifacts (T32) ─────────────────────────────────────────────────

export interface Artifact {
  id: string;
  type: "file" | "image" | "data" | "code" | "reference";
  name: string;
  path: string;
  mimeType?: string;
  size: number;
  createdAt: number;
  source?: string; // which tool/operation created it
  verified: boolean;
}

export class ArtifactStore {
  private artifacts = new Map<string, Artifact>();
  private counter = 0;

  add(artifact: Omit<Artifact, "id" | "createdAt">): Artifact {
    const id = `art-${++this.counter}`;
    const full: Artifact = { ...artifact, id, createdAt: Date.now() };
    this.artifacts.set(id, full);
    return full;
  }

  get(id: string): Artifact | undefined { return this.artifacts.get(id); }
  list(): Artifact[] { return [...this.artifacts.values()].sort((a, b) => b.createdAt - a.createdAt); }
  byType(type: Artifact["type"]): Artifact[] { return this.list().filter((a) => a.type === type); }

  /**
   * Format artifact list for chat display.
   */
  formatList(): string {
    const arts = this.list();
    if (arts.length === 0) return "Nenhum artefato nesta sessão.";

    const typeIcons: Record<string, string> = {
      file: "📄", image: "🖼️", data: "📊", code: "💻", reference: "🔗",
    };

    return arts.map((a, i) => {
      const icon = typeIcons[a.type] ?? "📎";
      const size = a.size > 1024 ? `${(a.size / 1024).toFixed(1)}KB` : `${a.size}B`;
      const verified = a.verified ? " ✓" : "";
      return `  ${i + 1}. ${icon} ${a.name} (${size})${verified}`;
    }).join("\n");
  }
}
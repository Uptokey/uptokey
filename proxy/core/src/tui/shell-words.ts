/**
 * Uptokey TUI — command line → structured argv.
 *
 * `!npm test -- --watch=false` becomes ["npm","test","--","--watch=false"]
 * for the isolated runner. Quotes and backslash escapes are honoured; shell
 * operators (pipes, redirects, `;`, `&&`, subshells, globbing is left literal)
 * are refused instead of being approximated, because there is no shell in the
 * runner and pretending otherwise would change what the person approved.
 */
import { t } from "./i18n.ts";

export type ParsedCommand = { ok: true; argv: string[] } | { ok: false; reason: string };

const OPERATORS = new Set(["|", "||", "&", "&&", ";", ">", ">>", "<", "<<", "2>", "2>&1"]);

export function parseCommandLine(line: string): ParsedCommand {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === "\\" && quote === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) { current += line[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < line.length) { current += line[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (has) { argv.push(current); current = ""; has = false; } continue; }
    if ("|&;<>`".includes(ch)) return { ok: false, reason: t("sw_operator", { operator: ch }) };
    if (ch === "$" && line[i + 1] === "(") return { ok: false, reason: t("sw_substitution") };
    current += ch; has = true;
  }
  if (quote) return { ok: false, reason: t("sw_unclosed_quote") };
  if (has) argv.push(current);
  if (!argv.length) return { ok: false, reason: "comando vazio" };
  if (argv.some((a) => OPERATORS.has(a))) return { ok: false, reason: t("sw_operators") };
  if (!/^[A-Za-z0-9._+/-]{1,200}$/.test(argv[0]!)) return { ok: false, reason: t("sw_invalid_program", { program: argv[0]!.slice(0, 60) }) };
  if (argv.length > 64) return { ok: false, reason: t("sw_too_many_args") };
  return { ok: true, argv };
}

/** Runtime profile that can execute the program (null when none fits). */
export function profileForProgram(program: string, files: readonly string[]): "node-app" | "python-app" | null {
  const base = program.split("/").pop()!;
  if (["node", "npm", "npx", "yarn", "pnpm", "corepack", "tsc", "vitest", "jest", "eslint", "prettier"].includes(base)) return "node-app";
  if (/^python(3(\.\d+)?)?$/.test(base) || ["pip", "pip3", "pytest", "ruff", "mypy"].includes(base)) return "python-app";
  if (files.includes("package.json")) return "node-app";
  if (files.some((f) => f.endsWith(".py"))) return "python-app";
  return null;
}

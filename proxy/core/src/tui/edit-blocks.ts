/**
 * Uptokey TUI — edit proposals from model text.
 *
 * The model proposes edits as SEARCH/REPLACE blocks (the format popularized by
 * Aider, Apache-2.0: aider/coders/editblock_coder.py — format and diagnostic
 * ideas only, independent implementation). Parsing and application are pure:
 * prose never executes. A block applies only to the file it names, only when
 * its SEARCH text matches exactly one place (exact, then trailing-whitespace
 * insensitive, then uniformly re-indented); otherwise the proposal carries a
 * precise error with the most similar lines, and nothing is written.
 */

export interface EditBlock {
  path: string;
  search: string;
  replace: string;
  /** 1-based line in the model text where the block starts (diagnostics). */
  line: number;
}

export interface ParsedEdits {
  blocks: EditBlock[];
  /** Malformed or unsafe blocks with a reason; they never apply. */
  rejected: Array<{ line: number; path: string | null; reason: string }>;
}

const SEARCH = /^\s*<{5,9}\s*SEARCH\s*$/;
const DIVIDER = /^\s*={5,9}\s*$/;
const REPLACE = /^\s*>{5,9}\s*REPLACE\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const FILE_HEADING = /^\s*(?:#{1,6}\s+)?(?:\*\*[^*]+\*\*|`[^`]+`)\s*$/;

/** Normalizes a model-written path: strips markdown decoration, rejects unsafe forms. */
export function normalizeProposedPath(raw: string): { path: string } | { error: string } {
  let value = raw.trim()
    .replace(/^#+\s*/, "")
    .replace(/^(file|arquivo|path|caminho)\s*:\s*/i, "")
    .replace(/^[*_`"']+|[*_`"':]+$/g, "")
    .trim();
  value = value.replace(/\\/g, "/");
  if (!value) return { error: "caminho ausente antes do bloco" };
  if (/\s/.test(value) && !/^[^\s]+$/.test(value)) return { error: t("eb_invalid_path", { path: value.slice(0, 80) }) };
  if (/^[a-zA-Z]:\//.test(value) || value.startsWith("/")) return { error: `caminho absoluto recusado: ${value.slice(0, 80)}` };
  if (value.startsWith("./")) value = value.slice(2);
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "" || part === ".")) return { error: `caminho fora da pasta recusado: ${value.slice(0, 80)}` };
  if (value.length > 400) return { error: "caminho longo demais" };
  return { path: value };
}

/** File names that are commonly written without an extension. */
const EXTENSIONLESS = new Set(["makefile", "dockerfile", "containerfile", "license", "readme", "procfile", "gemfile", "rakefile", "jenkinsfile", "vagrantfile", "brewfile", "justfile"]);

/**
 * Whether the line before a plain code fence names the file that fence creates. An explanation such as
 * "Exemplo:" or "Output:" followed by a code block is not a file: only a path-like name (an extension, a directory,
 * a dotfile or a well-known extensionless name), a Markdown filename heading or an explicit "arquivo:/file:" label
 * turns a fence into a new-file proposal. SEARCH/REPLACE blocks keep their own rules.
 */
function namesAFile(raw: string): boolean {
  const line = raw.trim();
  const labelled = /^(file|arquivo|path|caminho)\s*:/i.test(line);
  const normalized = normalizeProposedPath(line);
  if ("error" in normalized) return false;
  const path = normalized.path;
  const last = path.split("/").at(-1) ?? "";
  if (/\s/.test(path)) return false;
  if (labelled || FILE_HEADING.test(line)) return true;
  return /\.[A-Za-z0-9_-]{1,12}$/.test(last) || path.includes("/") || last.startsWith(".") || EXTENSIONLESS.has(last.toLowerCase());
}

export function parseEditBlocks(text: string): ParsedEdits {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: EditBlock[] = [];
  const rejected: ParsedEdits["rejected"] = [];
  let sectionPath: string | undefined;
  let fence: { marker: string; length: number; start: number; path: string } | undefined;
  let currentFenceContent: string[] | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!SEARCH.test(lines[i]!)) {
      const marker = lines[i]!.match(FENCE);
      if (fence) {
        if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
          const rawPath = fence.path;
          const startLine = fence.start;
          fence = undefined;
          
          if (currentFenceContent && rawPath && namesAFile(rawPath)) {
            const normalized = normalizeProposedPath(rawPath);
            if (!("error" in normalized) && normalized.path) {
               // Only push if it wasn't intercepted by a SEARCH block inside
               blocks.push({ path: normalized.path, search: "", replace: currentFenceContent.join("\n"), line: startLine });
            }
          }
          currentFenceContent = undefined;
        } else {
          currentFenceContent?.push(lines[i]!);
        }
      } else if (marker) {
        let previous = i - 1;
        while (previous >= 0 && !lines[previous]!.trim()) previous--;
        const adjacent = previous >= 0 && !FENCE.test(lines[previous]!) ? lines[previous]! : "";
        fence = { marker: marker[1]![0]!, length: marker[1]!.length, start: i + 1, path: sectionPath ?? adjacent };
        currentFenceContent = [];
      } else if (lines[i]!.trim()) {
        // Only an explicit Markdown filename scopes consecutive edit fences.
        // Any intervening prose/new section ends it; content inside an edit never declares a target.
        sectionPath = FILE_HEADING.test(lines[i]!) ? lines[i]! : undefined;
      }
      continue;
    }
    
    currentFenceContent = undefined; // A SEARCH block invalidates the natural fence creation

    // A comment describing an edit is not a path. In a fence, resolve only the
    // explicit preamble/heading, never a prior replacement or a guessed project file.
    let j = i - 1;
    if (fence) while (j >= fence.start && (!lines[j]!.trim() || /^\s*\/\//.test(lines[j]!))) j--;
    else while (j >= 0 && (!lines[j]!.trim() || FENCE.test(lines[j]!))) j--;
    const rawPath = fence && j < fence.start ? fence.path : j >= 0 ? lines[j]! : "";
    const startLine = i + 1;
    const search: string[] = [];
    let k = i + 1;
    while (k < lines.length && !DIVIDER.test(lines[k]!)) {
      if (SEARCH.test(lines[k]!) || REPLACE.test(lines[k]!)) break;
      search.push(lines[k]!); k++;
    }
    if (k >= lines.length || !DIVIDER.test(lines[k]!)) {
      rejected.push({ line: startLine, path: null, reason: "bloco sem divisor =======" });
      i = k - 1; continue;
    }
    const replace: string[] = [];
    k++;
    while (k < lines.length && !REPLACE.test(lines[k]!)) {
      // Some providers repeat the reserved divider immediately before the
      // closing marker. That adjacent pair is an unambiguous terminator, not
      // replacement text. Do not guess across blanks/content or accept a
      // divider in the middle of the replacement: those remain malformed.
      if (DIVIDER.test(lines[k]!) && k + 1 < lines.length && REPLACE.test(lines[k + 1]!)) { k++; break; }
      if (SEARCH.test(lines[k]!) || DIVIDER.test(lines[k]!)) break;
      replace.push(lines[k]!); k++;
    }
    if (k >= lines.length || !REPLACE.test(lines[k]!)) {
      rejected.push({ line: startLine, path: null, reason: "bloco sem fechamento >>>>>>> REPLACE" });
      i = k - 1; continue;
    }
    const normalized = normalizeProposedPath(rawPath);
    if ("error" in normalized) rejected.push({ line: startLine, path: rawPath.trim() || null, reason: normalized.error });
    else blocks.push({ path: normalized.path, search: search.join("\n"), replace: replace.join("\n"), line: startLine });
    i = k;
  }
  return { blocks, rejected };
}

export interface FileSnapshot {
  /** Current text (null when the file does not exist). */
  text: string | null;
  sha256: string | null;
}

export interface AppliedFile {
  path: string;
  before: string | null;
  beforeSha256: string | null;
  /** Exact bytes to write, with the original EOL style and BOM preserved. */
  after: string;
  blocks: number;
  /** How matches were found, per block, for transparency in review. */
  matches: Array<"exact" | "trailing_whitespace" | "reindented" | "create" | "fuzzy">;
}

export interface ApplyFailure {
  path: string;
  line: number;
  reason: string;
  /** Most similar region of the current file, when one exists. */
  similar?: string;
}

export interface ApplyResult {
  files: AppliedFile[];
  failures: ApplyFailure[];
}

const BOM = String.fromCodePoint(0xfeff);

import { matchAndApply } from "../coding/edit-blocks-v2.ts";
import { t } from "./i18n.ts";
import type { MatchOptions } from "../coding/edit-blocks-v2.ts";
import { diff_match_patch } from "diff-match-patch";

/** Applies blocks per file, sequentially. A file with any failed block is not proposed. */
export function applyEditBlocks(blocks: readonly EditBlock[], snapshots: ReadonlyMap<string, FileSnapshot>, opts?: { useV2?: boolean, v2Opts?: MatchOptions }): ApplyResult {
  const byFile = new Map<string, EditBlock[]>();
  for (const block of blocks) byFile.set(block.path, [...(byFile.get(block.path) ?? []), block]);
  const files: AppliedFile[] = [];
  const failures: ApplyFailure[] = [];
  for (const [path, fileBlocks] of byFile) {
    const snapshot = snapshots.get(path);
    if (!snapshot) { failures.push({ path, line: fileBlocks[0]!.line, reason: t("eb_not_read") }); continue; }
    const original = snapshot.text;
    const hasBom = original?.startsWith(BOM) ?? false;
    const crlf = original !== null && original.includes("\r\n") && !/(^|[^\r])\n/.test(original);
    let current = original === null ? null : (hasBom ? original.slice(1) : original).replace(/\r\n/g, "\n");
    const matches: AppliedFile["matches"] = [];
    let failed = false;
    for (const block of fileBlocks) {
      if (block.search.trim() === "") {
        if (current !== null && current.length > 0) {
          failures.push({ path, line: block.line, reason: t("eb_empty_search_exists") });
          failed = true; break;
        }
        current = ensureTrailingNewline(block.replace);
        matches.push("create");
        continue;
      }
      if (current === null) { failures.push({ path, line: block.line, reason: t("eb_missing_file") }); failed = true; break; }
      
      let outcome;
      if (opts?.useV2) {
          const v2Res = matchAndApply(block, current, opts.v2Opts);
          if (v2Res.error) {
              outcome = { error: v2Res.error, similar: v2Res.similar };
          } else {
              outcome = { text: v2Res.text!, mode: v2Res.mode! };
          }
      } else {
          outcome = replaceOnce(current, block.search, block.replace);
      }
      
      if ("error" in outcome) {
        failures.push({ path, line: block.line, reason: outcome.error, ...(outcome.similar ? { similar: outcome.similar } : {}) });
        failed = true; break;
      }
      current = outcome.text;
      matches.push(outcome.mode);
    }
    if (failed || current === null) continue;
    let after = crlf ? current.replace(/\n/g, "\r\n") : current;
    if (hasBom) after = BOM + after;
    if (original !== null && after === original) {
      failures.push({ path, line: fileBlocks[0]!.line, reason: t("eb_no_change") });
      continue;
    }
    files.push({ path, before: original, beforeSha256: snapshot.sha256, after, blocks: fileBlocks.length, matches });
  }
  return { files, failures };
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

function replaceOnce(content: string, search: string, replace: string): { text: string; mode: AppliedFile["matches"][number] } | { error: string; similar?: string } {
  const lines = content.split("\n");
  const searchLines = trimOuterEmpty(search.split("\n"));
  const replaceLines = replace === "" ? [] : replace.split("\n");
  if (!searchLines.length) return { error: t("eb_search_empty") };

  const strategies: Array<{ mode: "exact" | "trailing_whitespace" | "reindented"; eq: (a: string, b: string) => boolean }> = [
    { mode: "exact", eq: (a, b) => a === b },
    { mode: "trailing_whitespace", eq: (a, b) => a.trimEnd() === b.trimEnd() },
  ];
  for (const strategy of strategies) {
    const found = findAll(lines, searchLines, strategy.eq);
    if (found.length === 1) {
      const at = found[0]!;
      return { text: [...lines.slice(0, at), ...replaceLines, ...lines.slice(at + searchLines.length)].join("\n"), mode: strategy.mode };
    }
    if (found.length > 1) return { error: `o trecho SEARCH aparece ${found.length} vezes; inclua mais linhas de contexto` };
  }
  // Uniform indentation difference (model dropped or added leading spaces).
  const reindented = findReindented(lines, searchLines);
  if (reindented.length === 1) {
    const { at, delta } = reindented[0]!;
    const adjusted = replaceLines.map((line) => (line.trim() ? applyIndent(line, delta) : line));
    return { text: [...lines.slice(0, at), ...adjusted, ...lines.slice(at + searchLines.length)].join("\n"), mode: "reindented" };
  }
  if (reindented.length > 1) return { error: t("eb_search_ambiguous", { count: reindented.length }) };
  
  // Fuzzy Match (Epic 2.1 - Resilient Editing - Aider style window replacement)
  const fuzzy = findFuzzyWindow(lines, searchLines);
  if (fuzzy) {
    const { start, end } = fuzzy;
    return { text: [...lines.slice(0, start), ...replaceLines, ...lines.slice(end)].join("\n"), mode: "fuzzy" };
  }

  const similar = mostSimilar(lines, searchLines);
  return { error: t("eb_search_mismatch"), ...(similar ? { similar } : {}) };
}

function findFuzzyWindow(lines: readonly string[], search: readonly string[]): { start: number; end: number } | null {
  if (!lines.length || !search.length) return null;
  const want = search.map(l => l.trim());
  let bestScore = 0;
  let bestWindow: { start: number; end: number } | null = null;
  
  // Slide a window. The window size can vary slightly because LLM might skip or add lines.
  const minSize = Math.max(1, search.length - 3);
  const maxSize = search.length + 3;
  
  for (let i = 0; i <= lines.length - minSize; i++) {
    for (let size = minSize; size <= maxSize && i + size <= lines.length; size++) {
      const window = lines.slice(i, i + size).map(l => l.trim());
      
      // Calculate matches. How many lines of `want` are in `window` in order?
      let wIdx = 0;
      let score = 0;
      for (const w of want) {
        if (!w) continue; // skip empty lines for scoring
        let found = false;
        while (wIdx < window.length) {
          if (window[wIdx] === w) {
            score++;
            wIdx++;
            found = true;
            break;
          }
          wIdx++;
        }
        if (!found) break;
      }
      
      // We want the score to be high, and the penalty for extra lines in window to be small
      const penalty = Math.abs(size - search.length) * 0.5;
      const finalScore = score - penalty;
      
      // Require at least 80% match of the non-empty search lines
      const nonEmpties = want.filter(x => x).length;
      if (score >= nonEmpties * 0.8 && finalScore > bestScore) {
        bestScore = finalScore;
        bestWindow = { start: i, end: i + size };
      }
    }
  }
  return bestWindow;
}

function trimOuterEmpty(lines: string[]): string[] {
  let start = 0, end = lines.length;
  while (start < end && !lines[start]!.trim()) start++;
  while (end > start && !lines[end - 1]!.trim()) end--;
  return lines.slice(start, end);
}

function findAll(lines: readonly string[], needle: readonly string[], eq: (a: string, b: string) => boolean): number[] {
  const out: number[] = [];
  outer: for (let i = 0; i + needle.length <= lines.length; i++) {
    for (let j = 0; j < needle.length; j++) if (!eq(lines[i + j]!, needle[j]!)) continue outer;
    out.push(i);
  }
  return out;
}

function leading(line: string): string { return /^[ \t]*/.exec(line)![0]; }

function findReindented(lines: readonly string[], needle: readonly string[]): Array<{ at: number; delta: { add: string; remove: string } }> {
  const out: Array<{ at: number; delta: { add: string; remove: string } }> = [];
  const firstNonEmpty = needle.findIndex((line) => line.trim());
  if (firstNonEmpty < 0) return out;
  outer: for (let i = 0; i + needle.length <= lines.length; i++) {
    const actual = leading(lines[i + firstNonEmpty]!);
    const proposed = leading(needle[firstNonEmpty]!);
    const delta = actual.startsWith(proposed) ? { add: actual.slice(proposed.length), remove: "" } : proposed.startsWith(actual) ? { add: "", remove: proposed.slice(actual.length) } : null;
    if (!delta) continue;
    for (let j = 0; j < needle.length; j++) {
      const want = needle[j]!;
      const have = lines[i + j]!;
      if (!want.trim()) { if (have.trim()) continue outer; continue; }
      if (applyIndent(want, delta).trimEnd() !== have.trimEnd()) continue outer;
    }
    out.push({ at: i, delta });
  }
  return out;
}

function applyIndent(line: string, delta: { add: string; remove: string }): string {
  if (delta.remove && line.startsWith(delta.remove)) return delta.add + line.slice(delta.remove.length);
  return delta.add + line;
}

function mostSimilar(lines: readonly string[], needle: readonly string[]): string | undefined {
  if (!lines.length) return undefined;
  const want = needle.map((line) => line.trim());
  let best = -1, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (let j = 0; j < want.length && i + j < lines.length; j++) if (lines[i + j]!.trim() === want[j] && want[j]) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0 || bestScore === 0) return undefined;
  return lines.slice(best, Math.min(lines.length, best + Math.max(needle.length, 3))).join("\n");
}

/** Instructions appended to the system context in build mode. */
export const EDIT_PROTOCOL_INSTRUCTIONS = [
  "Para propor alterações de arquivos use blocos SEARCH/REPLACE. Cada bloco começa com o caminho relativo do arquivo em uma linha própria:",
  "",
  "caminho/relativo/arquivo.ext",
  "<<<<<<< SEARCH",
  "linhas atuais exatas, com contexto suficiente para serem únicas",
  "=======",
  "linhas novas",
  ">>>>>>> REPLACE",
  "",
  "Regras: copie o trecho SEARCH exatamente do conteúdo fornecido; para criar arquivo novo use SEARCH vazio;",
  "para editar arquivo existente, leia-o com read_file antes de copiar seu SEARCH; não peça que a pessoa cole um arquivo que pode ser lido pelas ferramentas.",
  "Para criar um arquivo novo, confirme o caminho na pasta vinculada e use este formato (sem linha de conteúdo entre SEARCH e =======):",
  "",
  "limitacoes.md",
  "<<<<<<< SEARCH",
  "=======",
  "# Limitações",
  "",
  "Conteúdo novo solicitado pela pessoa.",
  ">>>>>>> REPLACE",
  "",
  "O bloco é uma proposta executável pelo Uptokey: a interface exibe o diff e aplica pelo escritor canônico após revisão e autorização. Não é necessário write_file, shell nem executor de testes para criar ou editar um documento.",
  "Prepare os blocos quando solicitados, sem exigir confirmação textual adicional para somente preparar a proposta. Nada é gravado antes da aprovação na interface; só confirme a gravação após receber o resultado real.",
].join("\n");

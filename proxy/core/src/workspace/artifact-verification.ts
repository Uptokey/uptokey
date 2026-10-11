/**
 * Valor de Uso V6 — verificações reais de um artefato, ligadas ao SHA-256 exato da saída.
 *
 * Cada verificação nomeia o que de fato conferiu (regra/versão/resultado/motivo): integridade
 * de bytes, estrutura do formato e cabeçalho de mídia. Nenhuma delas afirma que o conteúdo está
 * correto — abrir um JSON não prova a afirmação dentro dele; decodificar um cabeçalho de imagem
 * não prova a imagem pedida. Nada é executado: sem macros, scripts ou renderização ativa.
 */
import { createHash } from 'node:crypto';
import * as nodeModule from 'node:module';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Script, compileFunction } from 'node:vm';
import { artifactByteLimit } from './artifacts.ts';
import { sanitizeCsvCell } from './artifact-transforms.ts';
export type VerificationResult = 'passed' | 'failed' | 'not_applicable';
export interface VerificationCheck { rule: string; version: 1; result: VerificationResult; detail: string }
/**
 * Owner-supplied evidence for rules that need more than the artifact bytes. Every reader stays
 * inside the same principal/project; absence makes the rule not applicable, never passed.
 */
export interface VerificationContext {
  /** Canonical CSV body re-derived from the manifest's declared source; null when the source is unavailable. */
  rederiveCsv?(manifest: Record<string, unknown>, signal: AbortSignal): Promise<string | null>;
  /** Stored text of a cited source artifact (fetched text or search snippets); null when absent. */
  citationSource?(artifactId: string, signal: AbortSignal): Promise<string | null>;
  /** Canonical parser of the contract whose receipt produced this JSON artifact. */
  jsonContract?: { name: string; parse(value: unknown): unknown };
  /**
   * F3: Optional governed code executor. When provided, code blocks that pass syntax
   * checking are submitted to an isolated runtime (OCI container) for typecheck or test.
   * Returns { passed: boolean; exitCode: number; output: string; runtimeFingerprint: string }.
   * The executor must respect the AbortSignal and not exceed the deadline.
   */
  codeExecutor?(blocks: ReadonlyArray<{ lang: string; code: string }>, signal: AbortSignal): Promise<CodeExecutorResult>;
  /** Read completed W5 evidence only; GET verification never starts the project executor. */
  recordedCodeChecks?(signal: AbortSignal): Promise<VerificationCheck[]>;
}

/** F3: Result from the governed code executor. */
export interface CodeExecutorResult {
  readonly passed: boolean;
  readonly exitCode: number;
  readonly output: string;
  readonly runtimeFingerprint: string;
  readonly testsDiscovered: number;
}
export interface VerificationOptions { signal?: AbortSignal; timeoutMs?: number; context?: VerificationContext }
export interface VerificationCapability { id: string; version: 1; checks: readonly string[]; limitations: readonly string[] }
export interface ArtifactVerification {
  artifactId: string;
  sha256: string;
  mediaType: string;
  byteLength: number;
  checks: VerificationCheck[];
  overall: 'passed' | 'failed';
  verifiedAt: string;
  durationMs: number;
  scope: 'integrity_structure_and_declared_rules';
  capabilities: readonly VerificationCapability[];
  limits: { timeoutMs: number; maxBytes: number; csvMaxColumns: number; csvMaxRows: number; cancellation: 'cooperative' };
}

const TEXT_TYPES = new Set(['text/markdown', 'text/plain', 'application/json', 'text/csv']);
const CSV_MAX_COLUMNS = 4096, CSV_MAX_ROWS = 100_000, CSV_CHUNK_SIZE = 8192;
const CSV_CAPABILITY: VerificationCapability = Object.freeze({
  id: 'csv_structure_and_formula_prefixes', version: 1,
  checks: ['RFC 4180 quotes and record widths', 'canonical export formula-prefix policy, including header cells', 'derived CSV manifest dimensions when present'],
  limitations: ['No formula execution, calculation, reference resolution or cell type inference', 'Manifest dimensions do not authenticate provenance or validate the source data'],
});
const BASE_CAPABILITY: VerificationCapability = Object.freeze({
  id: 'integrity_and_structure', version: 1,
  checks: ['SHA-256 and byte length', 'format-specific UTF-8, JSON, Markdown fences or media headers'],
  limitations: ['No semantic quality, requirement, typecheck, code execution or document rendering guarantee', 'Cancellation is observed between bounded synchronous checks and each CSV chunk; an in-flight store read may finish after cancellation'],
});
const CODE_MAX_BLOCKS = 64, CODE_MAX_BYTES = 256 * 1024;
/**
 * Parser mode per fenced-block language. JavaScript variants use V8's strict JS
 * parser (vm.Script) which correctly rejects TypeScript-specific syntax such as
 * type annotations, enums and decorators. TypeScript variants continue using
 * Node's stripTypeScriptTypes. No code is ever executed.
 */
const CODE_PARSERS: Readonly<Record<string, 'javascript' | 'typescript' | 'json'>> = Object.freeze({
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', typescript: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json',
});
const MARKDOWN_CAPABILITY: VerificationCapability = Object.freeze({
  id: 'markdown_document_rules', version: 1,
  checks: ['GFM table rows match the header column count', 'JavaScript/TypeScript code blocks parse (Node type stripping, not executed); JSON blocks parse'],
  limitations: ['Code is parsed only: no type checking, test run or execution; that needs the sandboxed project runner, which this verifier does not start', 'Other languages and JSX are reported without a parser; rendering fidelity is not measured'],
});
const CITATION_CAPABILITY: VerificationCapability = Object.freeze({
  id: 'citation_excerpts', version: 1,
  checks: ['quoted excerpt SHA-256 equals the recorded digest', 'the excerpt occurs in the stored source artifact of this project'],
  limitations: ['Proves the excerpt was read from the stored source, not that the claim around it is true or that the source is correct'],
});
const JSON_CONTRACT_CAPABILITY: VerificationCapability = Object.freeze({
  id: 'json_contract', version: 1,
  checks: ['the canonical parser of the producing contract accepts the stored JSON'],
  limitations: ['Validates shape and types of the contract, not the correctness of values'],
});
const CODE_EXECUTOR_CAPABILITY: VerificationCapability = Object.freeze({
  id: 'isolated_code_execution', version: 1,
  checks: ['Code blocks submitted to a governed OCI-isolated runtime for typecheck/test'],
  limitations: ['Execution is isolated and governed; does not prove correctness of all edge cases', 'Depends on OCI runtime availability; reported as not_applicable when unavailable'],
});
const CSV_RULES_CAPABILITY: VerificationCapability = Object.freeze({
  id: 'csv_schema_and_derivation', version: 1,
  checks: ['header names present and unique (column references stay unambiguous)', 'per-column value types are reported', 'a derived CSV equals the canonical transform of its declared, still-stored source'],
  limitations: ['CSV carries values only: formulas are not executed or calculated', 'Reproducing the transform does not validate the source data itself'],
});
const check = (rule: string, result: VerificationResult, detail: string): VerificationCheck => ({ rule, version: 1, result, detail });

function utf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

type CsvStructure = { ok: true; rows: number; columns: number } | { ok: false; reason: string };
type CsvInspection = { ok: true; rows: number; columns: number; formulaPrefixes: number; firstFormulaCell?: string } | { ok: false; reason: string };

/** One scanner for the public synchronous structure check and cancellable verification. */
function* scanCsv(text: string): Generator<void, CsvInspection> {
  let fields = 1, quoted = false, afterQuote = false, fieldStart = true, line = 1;
  let rows = 0, columns = 0, cell = '', formulaPrefixes = 0, firstFormulaCell: string | undefined;
  const body = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!body.length) return { ok: false, reason: 'empty' };
  const finishCell = () => {
    // Reuse the exporter policy over decoded cell values. Quoting a formula in CSV is not
    // equivalent to neutralizing it for a spreadsheet. No formula is evaluated here.
    if (sanitizeCsvCell(cell).sanitized) {
      formulaPrefixes++;
      firstFormulaCell ??= `row_${rows + 1}_column_${fields}`;
    }
    cell = '';
  };
  const finishRow = (): string | undefined => {
    finishCell(); rows++;
    if (rows > CSV_MAX_ROWS) return 'row_limit_exceeded';
    if (!columns) columns = fields;
    if (fields !== columns) return `row_${rows}_has_${fields}_columns_expected_${columns}`;
    fields = 1; fieldStart = true; afterQuote = false;
  };
  let nextYield = 0;
  for (let i = 0; i < body.length; i++) {
    if (i >= nextYield) { nextYield = i + CSV_CHUNK_SIZE; yield; }
    const c = body[i]!;
    if (quoted) {
      if (c === '"') { if (body[i + 1] === '"') { cell += '"'; i++; continue; } quoted = false; afterQuote = true; fieldStart = false; continue; }
      if (c === '\n') line++;
      cell += c;
      continue;
    }
    if (c === '"') { if (!fieldStart) return { ok: false, reason: `stray_quote_line_${line}` }; quoted = true; continue; }
    if (c === ',') {
      finishCell(); fields++;
      if (fields > CSV_MAX_COLUMNS) return { ok: false, reason: 'column_limit_exceeded' };
      fieldStart = true; afterQuote = false; continue;
    }
    if (c === '\r' && body[i + 1] === '\n') continue;
    if (c === '\n') { const reason = finishRow(); if (reason) return { ok: false, reason }; line++; continue; }
    if (afterQuote) return { ok: false, reason: `content_after_quote_line_${line}` };
    if (c === '\r') return { ok: false, reason: `bare_cr_line_${line}` };
    cell += c;
    fieldStart = false;
  }
  if (quoted) return { ok: false, reason: 'unterminated_quote' };
  const reason = finishRow();
  return reason ? { ok: false, reason } : { ok: true, rows, columns, formulaPrefixes, firstFormulaCell };
}

/** RFC 4180 structure: quotes balanced and every record with the header's column count. */
export function csvStructure(text: string): CsvStructure {
  const scanner = scanCsv(text);
  let step = scanner.next();
  while (!step.done) step = scanner.next();
  const result = step.value;
  return result.ok ? { ok: true, rows: result.rows, columns: result.columns } : result;
}

/** Records of an already structure-validated CSV body (RFC 4180 quotes). */
function csvRecords(body: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) { if (c === '"') { if (body[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r' && body[i + 1] === '\n') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function cellType(value: string): 'empty' | 'number' | 'boolean' | 'date' | 'text' {
  const v = value.trim();
  if (!v) return 'empty';
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) return 'number';
  if (/^(true|false)$/i.test(v)) return 'boolean';
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v))) return 'date';
  return 'text';
}

/** Header and per-column types of a CSV body; types are reported, never inferred as errors. */
async function csvSchemaChecks(body: string, guard: () => void): Promise<VerificationCheck[]> {
  const records = csvRecords(body); guard();
  const header = records[0] ?? [];
  const names = header.map(name => name.trim());
  const empty = names.findIndex(name => !name), duplicate = names.findIndex((name, index) => name && names.indexOf(name) !== index);
  const checks = [check('schema.csv_header', empty >= 0 || duplicate >= 0 ? 'failed' : 'passed',
    empty >= 0 ? `column_${empty + 1}_has_no_name` : duplicate >= 0 ? `column_${duplicate + 1}_repeats_a_name` : `${names.length} unique column name(s)`)];
  const kinds = names.map(() => new Set<string>());
  for (let r = 1; r < records.length; r++) {
    if (r % 2048 === 0) { await yieldToEventLoop(); guard(); }
    records[r]!.forEach((value, index) => { const type = cellType(value); if (type !== 'empty') kinds[index]?.add(type); });
  }
  const summary = kinds.map(set => set.size === 0 ? 'empty' : set.size === 1 ? [...set][0]! : 'mixed');
  const counts = summary.reduce<Record<string, number>>((total, type) => ({ ...total, [type]: (total[type] ?? 0) + 1 }), {});
  checks.push(check('types.csv_columns', 'passed', Object.entries(counts).map(([type, count]) => `${count} ${type}`).join(', ') || 'no columns'));
  return checks;
}

async function csvChecks(text: string, guard: () => void, context: VerificationContext = {}, signal?: AbortSignal): Promise<VerificationCheck[]> {
  let body = text;
  let manifest: Record<string, unknown> | undefined;
  // This is the preamble emitted by runtime.deriveArtifactContent, not a general CSV
  // comment escape hatch. Unknown or malformed preambles are still parsed as CSV.
  if (text.startsWith('# ')) {
    const newline = text.indexOf('\n'), firstLine = newline < 0 ? text : text.slice(0, newline);
    try {
      const value: unknown = JSON.parse(firstLine.slice(2));
      if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).schema === 'uptokey.artifact-derivation.v1') {
        manifest = value as Record<string, unknown>;
        body = newline < 0 ? '' : text.slice(newline + 1);
      }
    } catch { /* The ordinary CSV parser reports malformed syntax without echoing data. */ }
  }
  guard();
  const scanner = scanCsv(body);
  let step = scanner.next();
  while (!step.done) { await yieldToEventLoop(); guard(); step = scanner.next(); }
  let result = step.value;
  // The canonical exporter represents an empty record set by an empty body.
  if (manifest && body.length === 0) result = { ok: true, rows: 0, columns: 0, formulaPrefixes: 0 };
  const checks = [result.ok === true ? check('structure.csv', 'passed', `${result.rows} rows x ${result.columns} columns`) : check('structure.csv', 'failed', result.reason)];
  if (result.ok === false) return checks;
  checks.push(check('structure.csv_formula_prefixes', result.formulaPrefixes ? 'failed' : 'passed',
    result.formulaPrefixes ? `${result.formulaPrefixes} cell(s) with unsanitized formula prefix; first ${result.firstFormulaCell}` : 'no unsanitized formula prefixes'));
  if (manifest) {
    const transform = manifest.transform && typeof manifest.transform === 'object' && !Array.isArray(manifest.transform) ? manifest.transform as Record<string, unknown> : undefined;
    const valid = manifest.version === 1 && transform?.format === 'csv' && Number.isSafeInteger(transform.rowCount) && Number.isSafeInteger(transform.columnCount)
      && transform.rowCount === Math.max(0, result.rows - 1) && transform.columnCount === result.columns;
    checks.push(check('structure.csv_manifest', valid ? 'passed' : 'failed', valid ? 'declared row and column counts match' : 'invalid_or_mismatched_dimensions'));
  }
  if (body.length) checks.push(...await csvSchemaChecks(body, guard));
  if (manifest && context.rederiveCsv) {
    // The transform is pure: re-running it on the still-stored source must reproduce these bytes.
    // A3: guardedRead ensures this await cannot extend past the shared deadline.
    const effectiveSignal = signal ?? new AbortController().signal;
    const expected = await guardedRead(context.rederiveCsv(manifest, effectiveSignal), effectiveSignal); guard();
    checks.push(expected === null ? check('derivation.reproducible', 'not_applicable', 'source_unavailable')
      : check('derivation.reproducible', expected === body ? 'passed' : 'failed', expected === body ? 'matches the canonical transform of the declared source' : 'differs_from_canonical_transform'));
  }
  return checks;
}

type MarkdownBlock = { lang: string; code: string };
/** Fenced blocks (CommonMark fences) and GFM table checks, outside code. */
function markdownDocument(text: string): { blocks: MarkdownBlock[]; unclosed: boolean; tableFailure: string | null; tables: number } {
  const blocks: MarkdownBlock[] = []; let opened: { marker: string; length: number; lang: string; lines: string[] } | undefined;
  const lines = text.split(/\r?\n/), outside: Array<string | null> = [];
  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opened) {
      if (fence && fence[1]![0] === opened.marker && fence[1]!.length >= opened.length && /^[ \t]*$/.test(fence[2]!)) { blocks.push({ lang: opened.lang, code: opened.lines.join('\n') }); opened = undefined; }
      else opened.lines.push(line);
      outside.push(null); continue;
    }
    if (fence && (fence[1]![0] !== '`' || !fence[2]!.includes('`'))) { opened = { marker: fence[1]![0]!, length: fence[1]!.length, lang: fence[2]!.trim().split(/\s+/)[0]!.toLowerCase(), lines: [] }; outside.push(null); continue; }
    outside.push(line);
  }
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).length;
  const delimiter = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  let tables = 0, tableFailure: string | null = null;
  for (let i = 1; i < outside.length && !tableFailure; i++) {
    const header = outside[i - 1], separator = outside[i];
    if (header === null || header === undefined || separator === null || separator === undefined || !header.includes('|') || !delimiter.test(separator)) continue;
    tables++; const width = cells(header);
    if (cells(separator) !== width) { tableFailure = `table_${tables}_delimiter_has_${cells(separator)}_cells_expected_${width}`; break; }
    for (let j = i + 1; j < outside.length; j++) {
      const row = outside[j];
      if (row === null || row === undefined || !row.trim() || !row.includes('|')) break;
      if (cells(row) !== width) { tableFailure = `table_${tables}_row_${j - i}_has_${cells(row)}_cells_expected_${width}`; break; }
    }
  }
  return { blocks, unclosed: Boolean(opened), tableFailure, tables };
}

/** Shared fence interpretation for the governed project runner; this function never executes code. */
export function artifactCodeBlocks(text: string): ReadonlyArray<{ lang: string; code: string }> {
  const document = markdownDocument(text);
  if (document.unclosed) throw new Error('runtime_artifact_unclosed_fence');
  const blocks = document.blocks.filter(block => CODE_PARSERS[block.lang] && CODE_PARSERS[block.lang] !== 'json');
  if (!blocks.length || blocks.length > CODE_MAX_BLOCKS || blocks.some(block => Buffer.byteLength(block.code) > CODE_MAX_BYTES)) {
    throw new Error('runtime_artifact_code_limit');
  }
  return blocks;
}

/**
 * Parse a single code block with the appropriate parser for its declared language.
 * JavaScript variants use vm.Script (V8's JS parser) which correctly rejects
 * TypeScript-specific syntax. TypeScript variants use stripTypeScriptTypes.
 * JSON uses JSON.parse. Nothing is ever executed.
 */
/** The runtime lacks the parser this block needs (Bun has no node:module stripTypeScriptTypes): never a pass. */
class ParserUnavailable extends Error {}
type StripTypes = (code: string, options: { mode: 'strip' | 'transform' }) => string;
// Namespace access keeps the module loadable where the export is absent; the check then reports not_applicable.
const stripTypeScriptTypes: StripTypes = (code, options) => {
  const strip = (nodeModule as { stripTypeScriptTypes?: StripTypes }).stripTypeScriptTypes;
  if (typeof strip !== 'function') throw new ParserUnavailable('typescript_parser_unavailable_in_runtime');
  return strip(code, options);
};
function parseCodeBlock(code: string, mode: 'javascript' | 'typescript' | 'json', lang: string): void {
  if (mode === 'json') { JSON.parse(code); return; }
  if (mode === 'typescript') { stripTypeScriptTypes(code, { mode: 'transform' }); return; }
  // JavaScript never accepts TypeScript-only syntax. Nothing below runs the code: V8 compiles
  // scripts/functions, and the module check uses Node's parser only to prove nothing was stripped.
  if (lang === 'cjs') { compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname']); return; }
  const module = () => {
    let stripped: string;
    try { stripped = stripTypeScriptTypes(code, { mode: 'strip' }); }
    catch (error) { if (error instanceof ParserUnavailable) throw error; throw new SyntaxError(error instanceof Error ? error.message.split('\n')[0] : 'module_parse_error'); }
    if (stripped !== code) throw new SyntaxError('TypeScript-only syntax in a JavaScript block');
  };
  if (lang === 'mjs') {
    // Module goal first; a strict script without import/export is also a valid module text.
    try { module(); } catch (error) { try { new Script(`'use strict';\n${code}`); } catch { throw error; } }
    return;
  }
  // js/javascript: script goal first, then module goal (import/export).
  try { new Script(code); } catch (error) { try { module(); } catch (moduleError) { throw moduleError instanceof ParserUnavailable ? moduleError : error; } }
}

/** Parse, never execute, the code blocks that have a parser here. Optionally submit to executor. */
async function codeBlockCheck(blocks: MarkdownBlock[], guard: () => void, context: VerificationContext, signal: AbortSignal): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  const known = blocks.filter(block => CODE_PARSERS[block.lang]);
  const unparsed = [...new Set(blocks.filter(block => block.lang && !CODE_PARSERS[block.lang]).map(block => block.lang))];
  if (!known.length) { checks.push(check('syntax.code_blocks', 'not_applicable', unparsed.length ? `no parser for ${unparsed.slice(0, 5).join(', ')}` : 'no_code_blocks_with_known_language')); return checks; }
  if (known.length > CODE_MAX_BLOCKS) { checks.push(check('syntax.code_blocks', 'not_applicable', `more_than_${CODE_MAX_BLOCKS}_blocks`)); return checks; }
  for (const [index, block] of known.entries()) {
    await yieldToEventLoop(); guard();
    if (Buffer.byteLength(block.code) > CODE_MAX_BYTES) { checks.push(check('syntax.code_blocks', 'not_applicable', `block_${index + 1}_exceeds_${CODE_MAX_BYTES}_bytes`)); return checks; }
    try {
      parseCodeBlock(block.code, CODE_PARSERS[block.lang]!, block.lang);
    } catch (error) {
      if (error instanceof ParserUnavailable) { checks.push(check('syntax.code_blocks', 'not_applicable', `block_${index + 1}_${block.lang}: ${error.message}`)); return checks; }
      const reason = error instanceof Error ? error.message.split('\n')[0]!.slice(0, 160) : 'parse_error';
      checks.push(check('syntax.code_blocks', 'failed', `block_${index + 1}_${block.lang}: ${reason}`));
      return checks;
    }
  }
  const counts = known.reduce<Record<string, number>>((total, block) => ({ ...total, [block.lang]: (total[block.lang] ?? 0) + 1 }), {});
  checks.push(check('syntax.code_blocks', 'passed', `${known.length} block(s) parsed, not executed (${Object.entries(counts).map(([lang, count]) => `${count} ${lang}`).join(', ')})${unparsed.length ? `; no parser for ${unparsed.slice(0, 5).join(', ')}` : ''}`));

  // F3: If a governed code executor is available, submit parsed blocks for isolated typecheck/test.
  if (context.codeExecutor && known.length > 0) {
    await yieldToEventLoop(); guard();
    try {
      const result = await guardedRead(context.codeExecutor(known.map(b => ({ lang: b.lang, code: b.code })), signal), signal);
      const detail = `exit=${result.exitCode}, tests=${result.testsDiscovered}, runtime=${result.runtimeFingerprint}, output=${result.output.slice(0, 200)}`;
      checks.push(check('execution.isolated_typecheck', result.passed ? 'passed' : 'failed', detail));
    } catch (error) {
      if (error instanceof VerificationStopped) throw error;
      const msg = error instanceof Error ? error.message.slice(0, 160) : 'executor_unavailable';
      checks.push(check('execution.isolated_typecheck', 'not_applicable', `executor_error: ${msg}`));
    }
  }
  return checks;
}

/**
 * Structured citation marker produced by the verified-citation action (PWA artifacts.tsx):
 * `<!-- uptokey:citation {JSON} -->`, JSON escaped so `<`/`>` never appear raw inside the comment.
 * Fields follow the existing SourceCitation identity: sourceArtifactId, excerptDigest, plus the
 * excerpt text. The human-readable legacy block may accompany it; the pair is counted once.
 */
const STRUCTURED_START = '<!-- uptokey:citation';
/** Legacy/human block anchor: the excerpt and "Fonte:" lines are found above it, never guessed. */
const LEGACY_ANCHOR = /^Arquivo: (\S+) · SHA-256: (\S+)[ \t]*$/;
const CITATION_LIMIT = 64;

interface ParsedCitation { artifactId: string; excerptDigest: string; excerpt: string }

/** Every recognizable marker is either parsed completely or counted as malformed — never dropped. */
function extractCitations(text: string): { citations: ParsedCitation[]; malformed: number } {
  const citations: ParsedCitation[] = [], seen = new Set<string>();
  let malformed = 0;
  const add = (item: ParsedCitation) => { const key = `${item.artifactId}\u0000${item.excerptDigest}\u0000${item.excerpt}`; if (!seen.has(key)) { seen.add(key); citations.push(item); } };
  const valid = (artifactId: unknown, digest: unknown, excerpt: unknown): artifactId is string =>
    typeof artifactId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(artifactId) && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
    && typeof excerpt === 'string' && excerpt.length > 0 && excerpt.length <= 4000;
  for (let at = text.indexOf(STRUCTURED_START); at >= 0; at = text.indexOf(STRUCTURED_START, at + STRUCTURED_START.length)) {
    const close = text.indexOf('-->', at);
    if (close < 0) { malformed++; break; }
    try {
      const raw = JSON.parse(text.slice(at + STRUCTURED_START.length, close).trim()) as Record<string, unknown>;
      const artifactId = raw?.sourceArtifactId ?? raw?.artifactId, digest = raw?.excerptDigest, excerpt = raw?.excerpt;
      if (valid(artifactId, digest, excerpt)) add({ artifactId, excerptDigest: digest as string, excerpt: excerpt as string }); else malformed++;
    } catch { malformed++; }
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!/^Arquivo: .*SHA-256/.test(lines[index]!)) continue;
    const anchor = LEGACY_ANCHOR.exec(lines[index]!), source = lines[index - 1];
    // The excerpt ends right above "Fonte:" with ” and starts at a line opening with “. Inner quotes
    // and line breaks belong to the excerpt: among the candidate openings, the recorded digest decides.
    let first = -1, excerpt = '';
    if (anchor && source?.startsWith('Fonte: ') && lines[index - 2]?.endsWith('\u201d'))
      for (let line = index - 2; line >= Math.max(0, index - 200); line--) {
        if (!lines[line]!.startsWith('\u201c')) continue;
        const block = lines.slice(line, index - 1).join('\n'), candidate = block.length >= 2 ? block.slice(1, -1) : '';
        if (first < 0) { first = line; excerpt = candidate; }
        if (createHash('sha256').update(candidate).digest('hex') === anchor[2]) { first = line; excerpt = candidate; break; }
      }
    if (anchor && first >= 0 && valid(anchor[1], anchor[2], excerpt)) add({ artifactId: anchor[1]!, excerptDigest: anchor[2]!, excerpt });
    else if (!citations.some(item => anchor && item.artifactId === anchor[1] && item.excerptDigest === anchor[2])) malformed++;
  }
  return { citations, malformed };
}

/**
 * Race a promise against the verification's AbortSignal. If the signal fires before
 * the promise settles, the result is discarded and VerificationStopped is thrown.
 * This ensures auxiliary reads (citationSource, rederiveCsv) cannot extend past the
 * shared deadline. No dangling listeners: cleanup via finally.
 */
async function guardedRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new VerificationStopped(signal.reason === 'timeout' ? 'timeout' : 'cancelled');
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (!settled) { settled = true; reject(new VerificationStopped(signal.reason === 'timeout' ? 'timeout' : 'cancelled')); }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { if (!settled) { settled = true; resolve(value); } },
      error => { if (!settled) { settled = true; reject(error); } },
    ).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Citation markers produced by the verified-citation action: excerpt, source artifact and digest. */
async function citationCheck(text: string, context: VerificationContext, guard: () => void, signal: AbortSignal): Promise<VerificationCheck | null> {
  const { citations, malformed } = extractCitations(text);
  if (!citations.length && !malformed) return null;
  if (!context.citationSource) return check('citations.source_excerpt', 'not_applicable', 'source_reader_unavailable');
  const markers = citations.slice(0, CITATION_LIMIT);
  for (const [index, marker] of markers.entries()) {
    if (createHash('sha256').update(marker.excerpt).digest('hex') !== marker.excerptDigest) return check('citations.source_excerpt', 'failed', `citation_${index + 1}_digest_mismatch`);
    const source = await guardedRead(context.citationSource(marker.artifactId, signal), signal); guard();
    if (source === null) return check('citations.source_excerpt', 'failed', `citation_${index + 1}_source_unavailable`);
    if (!source.includes(marker.excerpt)) return check('citations.source_excerpt', 'failed', `citation_${index + 1}_excerpt_not_in_source`);
  }
  // Coverage is explicit: incomplete markers or markers beyond the limit keep the rule from passing.
  if (malformed) return check('citations.source_excerpt', 'failed', `${malformed} incomplete or malformed citation marker(s); ${markers.length} checked`);
  if (citations.length > CITATION_LIMIT) return check('citations.source_excerpt', 'failed', `citation_limit_exceeded: ${CITATION_LIMIT} of ${citations.length} checked`);
  return check('citations.source_excerpt', 'passed', `${markers.length} excerpt(s) found in their stored sources`);
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** Header-level decoding of media containers: signature, dimensions or duration when present. */
export function mediaHeader(mediaType: string, b: Uint8Array): VerificationCheck {
  const rule = 'structure.media_header';
  if (mediaType === 'image/png') {
    if (b.length < 24 || u32(b, 0) !== 0x89504e47 || u32(b, 4) !== 0x0d0a1a0a || ascii(b, 12, 4) !== 'IHDR') return check(rule, 'failed', 'png_signature_or_ihdr_missing');
    const width = u32(b, 16), height = u32(b, 20);
    return width && height ? check(rule, 'passed', `png ${width}x${height}`) : check(rule, 'failed', 'png_zero_dimensions');
  }
  if (mediaType === 'image/jpeg') {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return check(rule, 'failed', 'jpeg_soi_missing');
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return check(rule, 'failed', 'jpeg_marker_invalid');
      const marker = b[i + 1]!, length = (b[i + 2]! << 8) | b[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const height = (b[i + 5]! << 8) | b[i + 6]!, width = (b[i + 7]! << 8) | b[i + 8]!;
        return width && height ? check(rule, 'passed', `jpeg ${width}x${height}`) : check(rule, 'failed', 'jpeg_zero_dimensions');
      }
      if (length < 2) return check(rule, 'failed', 'jpeg_segment_invalid');
      i += 2 + length;
    }
    return check(rule, 'failed', 'jpeg_frame_header_missing');
  }
  if (mediaType === 'image/webp') {
    if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return check(rule, 'failed', 'webp_riff_missing');
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X') return check(rule, 'passed', `webp ${1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16))}x${1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16))}`);
    if (chunk === 'VP8 ' || chunk === 'VP8L') return check(rule, 'passed', `webp ${chunk.trim()}`);
    return check(rule, 'failed', 'webp_chunk_unknown');
  }
  if (mediaType === 'audio/wav') {
    if (b.length < 44 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return check(rule, 'failed', 'wav_riff_missing');
    let offset = 12, byteRate = 0;
    while (offset + 8 <= b.length) {
      const id = ascii(b, offset, 4), size = u32le(b, offset + 4);
      if (id === 'fmt ') byteRate = u32le(b, offset + 16);
      if (id === 'data') return byteRate ? check(rule, 'passed', `wav ${(size / byteRate).toFixed(2)}s`) : check(rule, 'failed', 'wav_fmt_missing');
      offset += 8 + size + (size % 2);
    }
    return check(rule, 'failed', 'wav_data_missing');
  }
  if (mediaType === 'audio/mpeg') {
    const id3 = ascii(b, 0, 3) === 'ID3';
    const sync = b.length > 1 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0;
    return id3 || sync ? check(rule, 'passed', id3 ? 'mp3 id3' : 'mp3 frame_sync') : check(rule, 'failed', 'mp3_header_missing');
  }
  if (mediaType === 'audio/ogg') return ascii(b, 0, 4) === 'OggS' ? check(rule, 'passed', 'ogg page') : check(rule, 'failed', 'ogg_capture_pattern_missing');
  if (mediaType === 'audio/webm') return b.length >= 4 && u32(b, 0) === 0x1a45dfa3 ? check(rule, 'passed', 'webm ebml') : check(rule, 'failed', 'webm_ebml_missing');
  if (mediaType === 'audio/mp4' || mediaType === 'video/mp4') {
    return b.length >= 12 && ascii(b, 4, 4) === 'ftyp' ? check(rule, 'passed', `mp4 ${ascii(b, 8, 4).trim()}`) : check(rule, 'failed', 'mp4_ftyp_missing');
  }
  return check(rule, 'not_applicable', 'no_header_rule');
}

async function textChecks(mediaType: string, bytes: Uint8Array, guard: () => void, context: VerificationContext, signal: AbortSignal): Promise<VerificationCheck[]> {
  const text = utf8(bytes);
  if (text === null) return [check('structure.utf8', 'failed', 'invalid_utf8')];
  const checks = [check('structure.utf8', text.includes('\u0000') ? 'failed' : 'passed', text.includes('\u0000') ? 'nul_byte' : 'valid')];
  if (mediaType === 'application/json') {
    let value: unknown, parsed = false;
    try { value = JSON.parse(text); parsed = true; checks.push(check('structure.json', 'passed', Array.isArray(value) ? `array ${value.length}` : typeof value)); }
    catch { checks.push(check('structure.json', 'failed', 'parse_error')); }
    if (parsed && context.jsonContract) {
      try { context.jsonContract.parse(value); checks.push(check('schema.json_contract', 'passed', context.jsonContract.name)); }
      catch (error) { checks.push(check('schema.json_contract', 'failed', `${context.jsonContract.name}: ${error instanceof Error ? error.message.slice(0, 120) : 'invalid'}`)); }
    }
  } else if (mediaType === 'text/csv') {
    checks.push(...await csvChecks(text, guard, context, signal));
  } else if (mediaType === 'text/markdown') {
    const document = markdownDocument(text);
    checks.push(check('structure.markdown_fences', document.unclosed ? 'failed' : 'passed', document.unclosed ? 'unclosed_code_fence' : `${document.blocks.length} code block(s)`));
    checks.push(document.tables ? check('structure.markdown_tables', document.tableFailure ? 'failed' : 'passed', document.tableFailure ?? `${document.tables} table(s) with consistent columns`)
      : check('structure.markdown_tables', 'not_applicable', 'no_tables'));
    if (!document.unclosed) checks.push(...(await codeBlockCheck(document.blocks, guard, context, signal)));
  }
  if (mediaType === 'text/markdown' || mediaType === 'text/plain') {
    const citations = await citationCheck(text, context, guard, signal);
    if (citations) checks.push(citations);
  }
  return checks;
}

/**
 * Verify the stored bytes of one artifact. `read` is the store reader: it re-hashes the sealed
 * bytes and throws `workspace_artifact_hash_mismatch` when they no longer match the record.
 */
export async function verifyArtifact(
  artifact: { id: string; mediaType: string; sha256: string; byteLength: number },
  read: (binary: boolean, signal?: AbortSignal) => Promise<Uint8Array>,
  now: () => Date = () => new Date(),
  options: VerificationOptions = {},
): Promise<ArtifactVerification> {
  const started = performance.now();
  const binary = !TEXT_TYPES.has(artifact.mediaType);
  const checks: VerificationCheck[] = [];
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(10_000, Math.trunc(options.timeoutMs!))) : 5000;
  const maxBytes = artifactByteLimit(artifact.mediaType === 'video/mp4' ? 'video/mp4' : 'text/plain');
  const controller = new AbortController();
  const cancel = () => controller.abort('cancelled');
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const guard = () => {
    if (!controller.signal.aborted && performance.now() - started >= timeoutMs) controller.abort('timeout');
    if (controller.signal.aborted) throw new VerificationStopped(controller.signal.reason === 'timeout' ? 'timeout' : 'cancelled');
  };
  try {
    guard();
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0 || artifact.byteLength > maxBytes) throw new VerificationStopped('byte_limit');
    // A late reader is observed but cannot resume verification or replace the failure result.
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const aborted = () => reject(new VerificationStopped(controller.signal.reason === 'timeout' ? 'timeout' : 'cancelled'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => { guard(); return read(binary, controller.signal); }).then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', aborted));
    });
    guard();
    const valid = bytes.byteLength === artifact.byteLength && createHash('sha256').update(bytes).digest('hex') === artifact.sha256;
    checks.push(check('integrity.sha256', valid ? 'passed' : 'failed', valid ? `${artifact.byteLength} bytes` : 'stored_bytes_do_not_match_record'));
    if (valid) {
      await yieldToEventLoop(); guard();
      checks.push(...(binary ? [mediaHeader(artifact.mediaType, bytes)] : await textChecks(artifact.mediaType, bytes, guard, options.context ?? {}, controller.signal)));
      if(options.context?.recordedCodeChecks){guard();checks.push(...await guardedRead(options.context.recordedCodeChecks(controller.signal),controller.signal));}
      guard();
    }
  } catch (error) {
    if (error instanceof VerificationStopped) checks.push(check(`verification.${error.message}`, 'failed', error.message));
    else {
      const message = error instanceof Error ? error.message : '';
      if (message !== 'workspace_artifact_hash_mismatch' && message !== 'workspace_integrity_failed') throw error;
      checks.push(check('integrity.sha256', 'failed', 'stored_bytes_do_not_match_record'));
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
  return {
    artifactId: artifact.id, sha256: artifact.sha256, mediaType: artifact.mediaType, byteLength: artifact.byteLength, checks,
    overall: checks.some(item => item.result === 'failed') ? 'failed' : 'passed',
    verifiedAt: now().toISOString(), durationMs: Math.round(performance.now() - started), scope: 'integrity_structure_and_declared_rules',
    capabilities: [BASE_CAPABILITY,
      ...(artifact.mediaType === 'text/csv' ? [CSV_CAPABILITY, CSV_RULES_CAPABILITY] : []),
      ...(artifact.mediaType === 'text/markdown' ? [MARKDOWN_CAPABILITY] : []),
      ...(artifact.mediaType === 'application/json' && options.context?.jsonContract ? [JSON_CONTRACT_CAPABILITY] : []),
      ...(checks.some(item => item.rule === 'citations.source_excerpt') ? [CITATION_CAPABILITY] : []),
      ...(checks.some(item => item.rule === 'execution.isolated_typecheck') ? [CODE_EXECUTOR_CAPABILITY] : []),
      ...(checks.some(item=>item.rule.startsWith('execution.artifact_'))?[{id:'governed_artifact_code_verification',version:1 as const,checks:['Stored W5 typecheck/test report bound to artifact SHA-256, project snapshot and OCI image'],limitations:['Only the explicitly approved run is reported; changes require another approval','Code blocks use generated files in the chosen project directory; dependencies must exist in the pinned image or approved public snapshot','No guarantee of semantic correctness or test completeness; reading this report never executes code']}]:[])],
    limits: { timeoutMs, maxBytes, csvMaxColumns: CSV_MAX_COLUMNS, csvMaxRows: CSV_MAX_ROWS, cancellation: 'cooperative' },
  };
}

class VerificationStopped extends Error {}

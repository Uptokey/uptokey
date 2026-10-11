/**
 * Caches styled message lines by item version, width and expansion.
 * The viewport is anchored to an item and line offset; appending content
 * preserves that position, and scrolling up disables automatic tail following.
 */
import { sanitizeForDisplay } from "./sanitize.ts";
import { healStreamingMarkdown } from "./markdown-heal.ts";
import { chromeText } from "./ui-chrome.ts";
import { getLang } from "./i18n.ts";
import { graphemes, graphemeWidth, stringWidth, truncateCells } from "./unicode.ts";

export type Tone = "user" | "assistant" | "muted" | "accent" | "success" | "warning" | "danger" | "code" | "heading" | "link" | "plain";

export interface Span {
  text: string;
  tone?: Tone;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  inverse?: boolean;
  /** UTF-16 bounds in sanitized message source; UI chrome has no source. */
  sourceStart?: number;
  sourceEnd?: number;
  /** One source grapheme rendered with a different cell string (e.g. a tab). */
  sourceAtomic?: boolean;
}

export interface Line {
  spans: Span[];
  itemId?: string;
  itemLineIndex?: number;
}

export type ToolStatus = "pending" | "running" | "done" | "error" | "rejected";

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; attachments?: string[]; mediaAttachments?: Array<{ kind: "image" | "audio"; artifactId: string; name?: string }>; steer?: boolean; time?: string }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean; interrupted?: "failed" | "cancelled"; label?: string }
  | { kind: "tool"; id: string; name: string; summary: string; status: ToolStatus; detail?: string; receipt?: string | null }
  | { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string; hint?: string }
  | { kind: "change"; id: string; title: string; files: Array<{ path: string; added: number; removed: number; status?: string }>; state: "proposed" | "reviewing" | "approved" | "applying" | "applied" | "conflict" | "rejected" | "failed"; receipt?: string | null; hint?: string }
  | { kind: "run"; id: string; title: string; state: "preparing" | "awaiting_approval" | "running" | "passed" | "failed" | "blocked" | "cancelled"; detail?: string; receipt?: string | null }
  | { kind: "compaction"; id: string; covered: number; summary: string }
  | { kind: "task"; id: string; title: string; state: "preparing" | "awaiting_approval" | "ready" | "running" | "succeeded" | "blocked" | "needs_attention" | "cancelled" | "expired" | "failed"; children: Array<{ label: string; status: string; model?: string | null; receipt?: string | null }>; detail?: string }
  | { kind: "intro"; id: string; title: string; lines: string[] };

export interface RenderOptions {
  width: number;
  expanded: boolean;
  /** Linear mode for screen readers: no box glyphs, explicit role labels. */
  linear: boolean;
}

const MAX_COLLAPSED_DETAIL_LINES = 3;

function span(text: string, tone?: Tone, extra: Omit<Span, "text" | "tone"> = {}): Span {
  return { text, ...(tone ? { tone } : {}), ...extra };
}

/** Wraps a run of styled spans to `width` cells, prefixing continuation rows. */
export function wrapSpans(spans: readonly Span[], width: number, firstPrefix: Span[] = [], restPrefix: Span[] = firstPrefix): Line[] {
  const cells: Array<{ g: string; style: Span }> = [];
  for (const s of spans) {
    let offset = s.sourceStart;
    for (const g of graphemes(s.text)) {
      const style = offset === undefined ? s : { ...s, sourceStart: offset, sourceEnd: offset + g.length, ...(g === "\t" ? { sourceAtomic: true } : {}) };
      cells.push({ g: g === "\t" ? "    " : g, style });
      if (offset !== undefined) offset += g.length;
    }
  }
  const prefixWidth = (p: Span[]) => p.reduce((n, s) => n + stringWidth(s.text), 0);
  const out: Line[] = [];
  let prefix = firstPrefix;
  let i = 0;
  do {
    const avail = Math.max(1, width - prefixWidth(prefix));
    let used = 0;
    let j = i;
    let lastSpace = -1;
    while (j < cells.length) {
      const w = cells[j]!.g === "    " ? 4 : graphemeWidth(cells[j]!.g);
      if (used + w > avail && j > i) break;
      used += w;
      if (cells[j]!.g === " ") lastSpace = j;
      j++;
    }
    const end = j < cells.length && lastSpace > i ? lastSpace + 1 : j;
    const line: Span[] = prefix.map((p) => ({ ...p }));
    for (let k = i; k < end; k++) appendCell(line, cells[k]!.g, cells[k]!.style);
    out.push({ spans: line });
    i = end;
    while (i < cells.length && cells[i]!.g === " ") i++;
    prefix = restPrefix;
  } while (i < cells.length);
  return out;
}

function appendCell(line: Span[], g: string, style: Span): void {
  const last = line[line.length - 1];
  if (last && last.tone === style.tone && last.bold === style.bold && last.dim === style.dim && last.italic === style.italic && last.inverse === style.inverse &&
      !last.sourceAtomic && !style.sourceAtomic && (last.sourceStart === undefined ? style.sourceStart === undefined : last.sourceEnd === style.sourceStart)) {
    last.text += g;
    if (style.sourceEnd !== undefined) last.sourceEnd = style.sourceEnd;
  } else {
    line.push({ ...style, text: g });
  }
}

/** Inline markdown: `code`, **bold**, [text](url). Anything else stays literal. */
export function inlineSpans(text: string, base: Span = { text: "" }, sourceStart?: number): Span[] {
  const out: Span[] = [];
  const mapped = (value: string, offset: number, style: Partial<Span> = {}): Span => ({ ...base, ...style, text: value,
    ...(sourceStart === undefined ? {} : { sourceStart: sourceStart + offset, sourceEnd: sourceStart + offset + value.length }) });
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) out.push(mapped(text.slice(last, index), last));
    const token = match[0];
    if (match[1]) out.push(mapped(token.slice(1, -1), index + 1, { tone: "code" }));
    else if (match[2]) out.push(mapped(token.slice(2, -2), index + 2, { bold: true }));
    else {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token) ?? [];
      out.push(mapped(label ?? token, index + 1, { tone: "link" }));
      if (url) out.push({ ...base, text: " (", dim: true }, mapped(url, index + (label?.length ?? 0) + 3, { dim: true }), { ...base, text: ")", dim: true });
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(mapped(text.slice(last), last));
  return out.length ? out : [mapped(text, 0)];
}

/** Markdown-lite block rendering for assistant text. */
export function markdownLines(text: string, options: RenderOptions, indent = 2): Line[] {
  const out: Line[] = [];
  const pad: Span[] = indent ? [span(" ".repeat(indent))] : [];
  const width = options.width;
  let inCode = false;
  let codeLang = "";
  let nextOffset = 0;
  for (const raw of text.split("\n")) {
    const offset = nextOffset; nextOffset += raw.length + 1;
    const fence = /^\s*(```|~~~)(.*)$/.exec(raw);
    if (fence) {
      if (!inCode) {
        inCode = true; codeLang = fence[2]!.trim();
        out.push({ spans: [...pad, span(options.linear ? chromeText("code_start", { language: codeLang || "" }) : `  ${codeLang || chromeText("code")}`, "muted", { dim: true })] });
      } else {
        inCode = false;
        out.push({ spans: [...pad, span(options.linear ? chromeText("code_end") : "  ", "muted", { dim: true })] });
      }
      continue;
    }
    if (inCode) {
      const bar = options.linear ? "" : "  ";
      out.push(...wrapSpans([span(raw, "code", { sourceStart: offset, sourceEnd: offset + raw.length })], width, [...pad, span(bar, "muted", { dim: true })], [...pad, span(options.linear ? "" : "  ", "muted", { dim: true })]));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) { out.push(...wrapSpans(inlineSpans(heading[2]!, { text: "", tone: "heading", bold: true }, offset + raw.length - heading[2]!.length), width, pad)); continue; }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      const level = Math.min(4, Math.floor(bullet[1]!.length / 2));
      const lead = " ".repeat(level * 2);
      out.push(...wrapSpans(inlineSpans(bullet[2]!, { text: "" }, offset + raw.length - bullet[2]!.length), width, [...pad, span(`${lead}• `, "accent")], [...pad, span(`${lead}  `)]));
      continue;
    }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw);
    if (numbered) {
      const marker = `${numbered[2]}. `;
      out.push(...wrapSpans(inlineSpans(numbered[3]!, { text: "" }, offset + raw.length - numbered[3]!.length), width, [...pad, span(marker, "accent")], [...pad, span(" ".repeat(marker.length))]));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) { out.push(...wrapSpans(inlineSpans(quote[1]!, { text: "", italic: true }, offset + raw.length - quote[1]!.length), width, [...pad, span("▎ ", "muted")])); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { out.push({ spans: [...pad, span("─".repeat(Math.max(3, Math.min(40, width - indent))), "muted", { dim: true })] }); continue; }
    if (!raw.trim()) { out.push({ spans: [] }); continue; }
    out.push(...wrapSpans(inlineSpans(raw, { text: "" }, offset), width, pad));
  }
  // Collapse runs of empty lines.
  return out.filter((line, i) => line.spans.length || !(out[i - 1] && !out[i - 1]!.spans.length));
}

const STATUS_GLYPH: Record<ToolStatus, [string, Tone]> = {
  pending: ["○", "muted"], running: ["◐", "accent"], done: ["✓", "success"], error: ["✗", "danger"], rejected: ["⊘", "muted"],
};

function detailLines(detail: string, options: RenderOptions, indent: number): Line[] {
  const all = sanitizeForDisplay(detail).split("\n");
  const limit = options.expanded ? all.length : Math.min(all.length, MAX_COLLAPSED_DETAIL_LINES);
  const lines: Line[] = [];
  const pad = [span(" ".repeat(indent))];
  for (const text of all.slice(0, limit)) lines.push(...wrapSpans([span(text, "muted", { dim: true })], options.width, pad));
  if (all.length > limit) lines.push({ spans: [...pad, span(chromeText("details_more", { count: all.length - limit }), "muted", { dim: true })] });
  return lines;
}

/** Renders one item into lines (without trailing spacing). */
export function renderItem(item: TranscriptItem, options: RenderOptions): Line[] {
  const width = Math.max(10, options.width);
  switch (item.kind) {
    case "user": {
      const label = item.steer ? `↯ ${chromeText("user_steer")}` : `› ${chromeText("user")}`;
      const lines: Line[] = [{ spans: [span(label, "user", { bold: true })] }];
      const textLines = sanitizeForDisplay(item.text).split("\n");
      let offset = 0;
      for (let i = 0; i < textLines.length; i++) {
        lines.push(...wrapSpans([span(textLines[i]!, undefined, { sourceStart: offset, sourceEnd: offset + textLines[i]!.length })], width, [span("  ")]));
        offset += textLines[i]!.length + 1;
      }
      if (item.attachments?.length) lines.push(...wrapSpans([span(chromeText("context", { paths: item.attachments.join(", ") }), "muted", { dim: true })], width, [span("  ")]));
      lines.forEach((l, i) => { l.itemId = item.id; l.itemLineIndex = i; });
      return lines;
    }
    case "assistant": {
      const text = sanitizeForDisplay(item.streaming ? healStreamingMarkdown(item.text) : item.text);
      const lines: Line[] = [{ spans: [span(item.label ?? "◆ Uptokey", "assistant", { bold: true }),
        ...(item.streaming ? [span(`  ${chromeText("responding")}`, "muted", { dim: true })] : []),
        ...(item.interrupted === "cancelled" ? [span(`  ${chromeText("interrupted")}`, "warning")] : item.interrupted === "failed" ? [span(`  ${chromeText("incomplete")}`, "danger")] : [])] }];
      if (text.trim()) lines.push(...markdownLines(text, { ...options, width }));
      lines.forEach((l, i) => { l.itemId = item.id; l.itemLineIndex = i; });
      return lines;
    }
    case "tool": {
      const [glyph, tone] = STATUS_GLYPH[item.status];
      const receipt = item.receipt ? `  ${chromeText("receipt", { id: item.receipt.slice(0, 8) })}` : "";
      const head = wrapSpans([span(`${glyph} `, tone), span(item.name, "accent", { bold: true }), span(` ${sanitizeForDisplay(item.summary)}`), span(receipt, "muted", { dim: true })], width, [span("  ")], [span("    ")]);
      const lines = item.detail ? [...head, ...detailLines(item.detail, options, 4)] : head;
      lines.forEach((l, i) => { l.itemId = item.id; l.itemLineIndex = i; });
      return lines;
    }
    case "notice": {
      const tone: Tone = item.level === "error" ? "danger" : item.level === "warning" ? "warning" : "muted";
      const glyph = item.level === "error" ? "✗" : item.level === "warning" ? "!" : "·";
      const lines = wrapSpans([span(`${glyph} `, tone), span(sanitizeForDisplay(item.text), tone === "muted" ? undefined : tone)], width, [span("  ")], [span("    ")]);
      if (item.hint) lines.push(...wrapSpans([span(item.hint, "muted", { dim: true })], width, [span("    ")]));
      lines.forEach((l, i) => { l.itemId = item.id; l.itemLineIndex = i; });
      return lines;
    }
    case "change": {
      const stateLabel: Record<typeof item.state, [string, Tone]> = {
        proposed: [chromeText("proposed"), "accent"], reviewing: [chromeText("reviewing"), "accent"], approved: [chromeText("approved"), "accent"],
        applying: [chromeText("applying"), "accent"], applied: [chromeText("applied"), "success"], conflict: [chromeText("conflict"), "danger"], rejected: [chromeText("rejected"), "muted"], failed: [chromeText("failed"), "danger"],
      };
      const [label, tone] = stateLabel[item.state];
      const added = item.files.reduce((n, f) => n + f.added, 0);
      const removed = item.files.reduce((n, f) => n + f.removed, 0);
      const lines: Line[] = [{ spans: [span("  ✎ ", "accent"), span(item.title, undefined, { bold: true }),
        span(`  ${chromeText(item.files.length === 1 ? "file_count" : "files_count", { count: item.files.length })}, +${added} −${removed}  `), span(label, tone),
        ...(item.receipt ? [span(`  ${chromeText("receipt", { id: item.receipt.slice(0, 8) })}`, "muted", { dim: true })] : [])] }];
      const shown = options.expanded ? item.files : item.files.slice(0, 6);
      for (const f of shown) {
        lines.push({ spans: [span("      "), span(truncateCells(f.path, Math.max(8, width - 26))), span(` +${f.added}`, "success"), span(` −${f.removed}`, "danger"),
          ...(f.status ? [span(`  ${f.status === "conflito" ? chromeText("conflict") : f.status}`, f.status === "conflito" ? "danger" : "muted", { dim: f.status !== "conflito" })] : [])] });
      }
      if (item.files.length > shown.length) lines.push({ spans: [span(`      ${chromeText("files_more", { count: item.files.length - shown.length })}`, "muted", { dim: true })] });
      if (item.hint) lines.push(...wrapSpans([span(item.hint, "muted", { dim: true })], width, [span("    ")]));
      lines.forEach((l, i) => { l.itemId = item.id; l.itemLineIndex = i; });
      return lines;
    }
    case "run": {
      const map: Record<typeof item.state, [string, Tone]> = {
        preparing: ["◌", "muted"], awaiting_approval: ["○", "accent"], running: ["◐", "accent"], passed: ["✓", "success"], failed: ["✗", "danger"], blocked: ["⊘", "warning"], cancelled: ["⊘", "muted"],
      };
      const [glyph, tone] = map[item.state];
      const lines = wrapSpans([span(`${glyph} `, tone), span(item.title, undefined, { bold: true }), ...(item.receipt ? [span(`  ${chromeText("receipt", { id: item.receipt.slice(0, 8) })}`, "muted", { dim: true })] : [])], width, [span("  ")], [span("    ")]);
      const result = item.detail ? [...lines, ...detailLines(item.detail, options, 4)] : lines;
      result.forEach((l, i) => { l.itemId = item.id; l.itemLineIndex = i; });
      return result;
    }
    case "task": {
      const map: Record<typeof item.state, [string, Tone]> = {
        preparing: ["◌", "muted"], awaiting_approval: ["○", "accent"], ready: ["◌", "accent"], running: ["◐", "accent"], succeeded: ["✓", "success"],
        blocked: ["⊘", "warning"], needs_attention: ["!", "warning"], cancelled: ["⊘", "muted"], expired: ["⊘", "muted"], failed: ["✗", "danger"],
      };
      const [glyph, tone] = map[item.state];
      const lines = wrapSpans([span(`${glyph} `, tone), span(options.linear ? chromeText("delegated_task", { title: item.title }) : item.title, undefined, { bold: true })], width, [span("  ")], [span("    ")]);
      item.children.forEach((child, index) => {
        const branch = options.linear ? chromeText("child", { count: index + 1 }) : index === item.children.length - 1 ? "  " : "  ";
        const tail = `${child.status}${child.model ? ` · ${child.model}` : ""}${child.receipt ? ` · ${chromeText("receipt", { id: child.receipt.slice(0, 8) })}` : ""}`;
        lines.push(...wrapSpans([span(branch, "muted"), span(child.label), span(`  ${tail}`, "muted", { dim: true })], width, [span("    ")], [span("      ")]));
      });
      const result = item.detail ? [...lines, ...detailLines(item.detail, options, 4)] : lines;
      result.forEach((l, i) => { l.itemId = item.id; l.itemLineIndex = i; });
      return result;
    }
    case "intro": {
      const lines: Line[] = [{ spans: [] }, { spans: [span(`  ${item.title}`, "accent", { bold: true })] }, ...item.lines.map((text) => ({ spans: [span(`  ${text}`, "muted", { dim: true })] }))];
      lines.forEach((l, i) => { l.itemId = item.id; l.itemLineIndex = i; });
      return lines;
    }
    case "compaction": {
      const lines: Line[] = [{ spans: [span("  ≡ ", "muted"), span(chromeText("compacted", { count: item.covered }), "muted", { bold: true })] }];
      if (options.expanded) lines.push(...markdownLines(sanitizeForDisplay(item.summary), options, 4));
      else lines.push({ spans: [span(`    ${chromeText("compacted_hint")}`, "muted", { dim: true })] });
      lines.forEach((l, i) => { l.itemId = item.id; l.itemLineIndex = i; });
      return lines;
    }
  }
}

function itemSignature(item: TranscriptItem): string {
  switch (item.kind) {
    case "user": return `${item.text.length}:${item.attachments?.join("|") ?? ""}:${item.steer ? 1 : 0}`;
    case "assistant": return `${item.text.length}:${item.text.slice(-32)}:${item.streaming ? 1 : 0}:${item.interrupted ?? ""}`;
    case "tool": return `${item.status}:${item.summary}:${item.detail?.length ?? 0}:${item.receipt ?? ""}`;
    case "notice": return `${item.level}:${item.text}:${item.hint ?? ""}`;
    case "change": return `${item.state}:${item.receipt ?? ""}:${item.hint ?? ""}:${item.files.map((f) => `${f.path}${f.added}${f.removed}${f.status ?? ""}`).join(",")}`;
    case "run": return `${item.state}:${item.title}:${item.detail?.length ?? 0}:${item.receipt ?? ""}`;
    case "compaction": return `${item.covered}:${item.summary.length}`;
    case "task": return `${item.state}:${item.title}:${item.children.map((c) => `${c.status}/${c.receipt ?? ""}/${c.model ?? ""}`).join(",")}:${item.detail?.length ?? 0}`;
    case "intro": return `${item.title}:${item.lines.join("|")}`;
  }
}

/** Caches rendered lines per item id + content signature + width + mode. */
export class TranscriptLayout {
  private cache = new Map<string, { key: string; lines: Line[] }>();

  linesFor(item: TranscriptItem, options: RenderOptions): Line[] {
    const key = `${itemSignature(item)}|${options.width}|${options.expanded ? 1 : 0}|${options.linear ? 1 : 0}|${getLang()}`;
    const cached = this.cache.get(item.id);
    if (cached && cached.key === key) return cached.lines;
    const lines = [...renderItem(item, options), { spans: [] }];
    this.cache.set(item.id, { key, lines });
    return lines;
  }

  /** Drops cache entries of items no longer present. */
  retain(items: readonly TranscriptItem[]): void {
    if (this.cache.size <= items.length * 2) return;
    const ids = new Set(items.map((i) => i.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }

  get size(): number { return this.cache.size; }
}

export interface Anchor { itemId: string; line: number }

export interface ViewportState {
  followTail: boolean;
  /** Top of the viewport when not following the tail. */
  anchor: Anchor | null;
}

export interface ViewportResult {
  lines: Line[];
  /** Lines below the visible window (0 when at the end). */
  below: number;
  /** Lines above the visible window. */
  above: number;
  total: number;
  anchor: Anchor | null;
}

/**
 * Computes the visible window. Only items intersecting the window are
 * rendered; line counts of the rest come from the cache (rendered once).
 */
export function computeViewport(items: readonly TranscriptItem[], layout: TranscriptLayout, options: RenderOptions, height: number, state: ViewportState): ViewportResult {
  const rows = Math.max(1, height);
  const counts = items.map((item) => layout.linesFor(item, options).length);
  const total = counts.reduce((a, b) => a + b, 0);
  let top: number;
  if (state.followTail || !state.anchor) {
    top = Math.max(0, total - rows);
  } else {
    const index = items.findIndex((item) => item.id === state.anchor!.itemId);
    if (index < 0) top = Math.max(0, total - rows);
    else {
      let offset = 0;
      for (let i = 0; i < index; i++) offset += counts[i]!;
      top = Math.min(Math.max(0, offset + Math.min(state.anchor.line, counts[index]! - 1)), Math.max(0, total - rows));
    }
  }
  const lines: Line[] = [];
  let cursor = 0;
  let anchor: Anchor | null = null;
  for (let i = 0; i < items.length && lines.length < rows; i++) {
    const count = counts[i]!;
    if (cursor + count <= top) { cursor += count; continue; }
    const itemLines = layout.linesFor(items[i]!, options);
    const startLine = Math.max(0, top - cursor);
    if (!anchor) anchor = { itemId: items[i]!.id, line: startLine };
    for (let l = startLine; l < itemLines.length && lines.length < rows; l++) lines.push(itemLines[l]!);
    cursor += count;
  }
  return { lines, below: Math.max(0, total - top - lines.length), above: top, total, anchor };
}

/** Scrolls by `delta` lines (negative = up). Reaching the end resumes following. */
export function scrollViewport(items: readonly TranscriptItem[], layout: TranscriptLayout, options: RenderOptions, height: number, state: ViewportState, delta: number): ViewportState {
  const current = computeViewport(items, layout, options, height, state);
  const maxTop = Math.max(0, current.total - Math.max(1, height));
  const nextTop = Math.min(maxTop, Math.max(0, current.above + delta));
  if (nextTop >= maxTop) return { followTail: true, anchor: null };
  let cursor = 0;
  for (const item of items) {
    const count = layout.linesFor(item, options).length;
    if (cursor + count > nextTop) return { followTail: false, anchor: { itemId: item.id, line: nextTop - cursor } };
    cursor += count;
  }
  return { followTail: true, anchor: null };
}

export function scrollToTop(items: readonly TranscriptItem[]): ViewportState {
  return items.length ? { followTail: false, anchor: { itemId: items[0]!.id, line: 0 } } : { followTail: true, anchor: null };
}

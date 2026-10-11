/**
 * Uptokey TUI — Markdown terminal renderer.
 * Converts markdown text to ANSI-styled terminal output.
 */

export interface RenderedLine {
  text: string;
  indent: number;
  style: "normal" | "heading" | "code" | "quote" | "list" | "hr";
}

/**
 * Render markdown to terminal-friendly lines with ANSI codes.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeLanguage = "";

  for (const line of lines) {
    // Code blocks
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = line.slice(3).trim();
        result.push(`\x1b[2m  ${codeLanguage || "code"}  \x1b[0m`);
      } else {
        inCodeBlock = false;
        codeLanguage = "";
        result.push("\x1b[2m  \x1b[0m");
      }
      continue;
    }

    if (inCodeBlock) {
      result.push(`\x1b[2m  \x1b[0m \x1b[33m${line}\x1b[0m`);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!;
      if (level === 1) result.push(`\x1b[1;36m${title}\x1b[0m`);
      else if (level === 2) result.push(`\x1b[1;34m${title}\x1b[0m`);
      else result.push(`\x1b[1m${title}\x1b[0m`);
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      result.push("\x1b[2m────────────────────────\x1b[0m");
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      result.push(`\x1b[2m│ \x1b[0m\x1b[3m${renderInline(line.slice(2))}\x1b[0m`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      const indent = ulMatch[1]!.length;
      result.push(`${" ".repeat(indent)}• ${renderInline(ulMatch[2]!)}`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
    if (olMatch) {
      const indent = olMatch[1]!.length;
      result.push(`${" ".repeat(indent)}  ${renderInline(olMatch[2]!)}`);
      continue;
    }

    // Normal text with inline formatting
    result.push(renderInline(line));
  }

  return result.join("\n");
}

/**
 * Apply inline formatting (bold, italic, code, links).
 */
function renderInline(text: string): string {
  return text
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m")
    .replace(/__(.+?)__/g, "\x1b[1m$1\x1b[22m")
    // Italic
    .replace(/\*(.+?)\*/g, "\x1b[3m$1\x1b[23m")
    .replace(/_(.+?)_/g, "\x1b[3m$1\x1b[23m")
    // Inline code
    .replace(/`([^`]+)`/g, "\x1b[33m$1\x1b[0m")
    // Strikethrough
    .replace(/~~(.+?)~~/g, "\x1b[9m$1\x1b[29m")
    // Links [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "\x1b[4;34m$1\x1b[0m");
}

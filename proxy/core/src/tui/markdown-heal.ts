/**
 * Closes incomplete Markdown markers for display while a response streams.
 * Only the rendered projection is healed; stored message text is unchanged.
 * Long streaming code blocks are bounded with a hidden-line count.
 */

/** Maximum code block lines to show while streaming. */
const MAX_CODE_BLOCK_LINES = 50;
/** Lines to show from the start of an oversized code block. */
const SHOW_LINES = 20;

/**
 * Close unclosed inline markdown markers so partial streaming content
 * renders cleanly without per-token flicker.
 *
 * Handles: **bold**, *italic*, `inline code`, ~~strikethrough~~
 * Does NOT attempt to close fenced code blocks (handled separately by
 * truncateStreamingCodeBlocks).
 */
export function healStreamingMarkdown(text: string): string {
  // Close unclosed inline code
  const backtickCount = (text.match(/`/g) ?? []).length;
  if (backtickCount % 2 !== 0) text += "`";

  // Close unclosed bold (**) — only if single-char bold is not open
  const boldCount = (text.match(/\*\*/g) ?? []).length;
  if (boldCount % 2 !== 0) text += "**";

  // Close unclosed italic (*) not part of bold
  // Count standalone * (not preceded/followed by another *)
  const standaloneItalic = (text.match(/(?<!\*)\*(?!\*)/g) ?? []).length;
  if (standaloneItalic % 2 !== 0) text += "*";

  // Close unclosed strikethrough (~~)
  const strikeCount = (text.match(/~~/g) ?? []).length;
  if (strikeCount % 2 !== 0) text += "~~";

  return text;
}

/**
 * Truncate oversized fenced code blocks in streaming content.
 * When a code block has more than MAX_CODE_BLOCK_LINES lines, only
 * SHOW_LINES are shown followed by a "[N lines truncated]" notice.
 * The fence is kept open so the renderer continues to treat it as code.
 */
export function truncateStreamingCodeBlocks(text: string): string {
  // Find opening code fences (``` or ~~~)
  const fenceRe = /^(`{3,}|~{3,})[^\n]*\n/gm;
  let result = text;
  let offset = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    const fenceChar = match[1]![0]!;
    const fenceLen = match[1]!.length;
    const closingFence = fenceChar.repeat(fenceLen);
    const blockStart = match.index + match[0].length; // content starts after the opening line

    // Look for closing fence in the remaining text
    const rest = text.slice(blockStart);
    const closingIdx = rest.indexOf("\n" + closingFence);
    const codeContent = closingIdx >= 0 ? rest.slice(0, closingIdx) : rest;
    const lines = codeContent.split("\n");

    if (lines.length > MAX_CODE_BLOCK_LINES) {
      const shown = lines.slice(0, SHOW_LINES).join("\n");
      const hidden = lines.length - SHOW_LINES;
      const truncated =
        text.slice(0, blockStart + offset) +
        shown +
        `\n\n[... ${hidden} lines not shown — streaming ...]\n`;
      // Adjust result and offset
      const originalLen = blockStart + codeContent.length;
      result =
        result.slice(0, blockStart + offset) +
        shown +
        `\n\n[... ${hidden} lines not shown — streaming ...]\n` +
        result.slice(originalLen + offset);
      offset += truncated.length - originalLen;
    }
  }
  return result;
}

/**
 * Prepare markdown content for rendering during streaming.
 * When settled (streaming = false), return the raw text unchanged.
 */
export function prepareStreamingContent(
  text: string,
  streaming: boolean,
): string {
  if (!streaming) return text;
  return healStreamingMarkdown(truncateStreamingCodeBlocks(text));
}

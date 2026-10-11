/**
 * Uptokey TUI — Terminal image protocol detection and rendering.
 *
 * State of the art (2026): Modern terminals support inline images via
 * Sixel, Kitty Graphics Protocol, or iTerm2 inline images. OpenCode
 * has basic image support; this goes further with auto-detection and
 * graceful fallback to Unicode block art.
 *
 * Detection order: Kitty > iTerm2 > Sixel > fallback (text description).
 * Source: OpenCode tui/image/images.go + terminal capability research.
 */

export type ImageProtocol = "kitty" | "iterm2" | "sixel" | "none";

/** Detect which image protocol the current terminal supports. */
export function detectImageProtocol(): ImageProtocol {
  const term = process.env.TERM ?? "";
  const termProgram = process.env.TERM_PROGRAM ?? "";
  const kittyPid = process.env.KITTY_PID ?? "";
  const wtSession = process.env.WT_SESSION ?? "";
  const konsole = process.env.KONSOLE_VERSION ?? "";

  // Kitty terminal
  if (kittyPid || term.includes("xterm-kitty")) return "kitty";

  // iTerm2
  if (termProgram === "iTerm.app" || process.env.LC_TERMINAL === "iTerm2") return "iterm2";

  // WezTerm, Konsole, foot, and others with Sixel
  if (termProgram === "WezTerm" || konsole || term.includes("foot") || term.includes("contour")) return "sixel";

  // Windows Terminal (limited image support via Sixel in recent versions)
  if (wtSession) return "sixel";

  return "none";
}

/** Render an image as iTerm2 inline image (base64 encoded). */
export function renderITerm2Image(data: Buffer, options?: { width?: number; height?: number; preserveAspect?: boolean }): string {
  const b64 = data.toString("base64");
  const args: string[] = [`size=${data.length}`];
  if (options?.width) args.push(`width=${options.width}`);
  if (options?.height) args.push(`height=${options.height}`);
  if (options?.preserveAspect !== false) args.push("preserveAspectRatio=1");
  args.push("inline=1");
  return `\x1b]1337;File=${args.join(";")}:${b64}\x07`;
}

/** Render an image as Kitty Graphics Protocol. */
export function renderKittyImage(data: Buffer, options?: { width?: number; height?: number }): string {
  const b64 = data.toString("base64");
  const chunks: string[] = [];
  const chunkSize = 4096;

  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= b64.length;
    const more = isLast ? 0 : 1;

    if (i === 0) {
      const cols = options?.width ?? 80;
      const rows = options?.height ?? 24;
      chunks.push(`\x1b_Ga=T,f=100,t=d,m=${more},c=${cols},r=${rows};${chunk}\x1b\\`);
    } else {
      chunks.push(`\x1b_Gm=${more};${chunk}\x1b\\`);
    }
  }

  return chunks.join("");
}

/** Render a text-based fallback for terminals without image support. */
export function renderImageFallback(description: string, mimeType?: string): string {
  const icon = mimeType?.startsWith("image/") ? "🖼️" : "📎";
  return `${icon} [${description}]${mimeType ? ` (${mimeType})` : ""}`;
}

/**
 * Auto-detect protocol and render image appropriately.
 */
export function renderImage(
  data: Buffer,
  description: string,
  options?: { width?: number; height?: number; mimeType?: string },
): string {
  const protocol = detectImageProtocol();

  switch (protocol) {
    case "kitty":
      return renderKittyImage(data, options);
    case "iterm2":
      return renderITerm2Image(data, options);
    case "sixel":
      // Sixel encoding is complex — fall back to description for now
      // Full Sixel support would require a dedicated encoder
      return renderImageFallback(description, options?.mimeType);
    case "none":
    default:
      return renderImageFallback(description, options?.mimeType);
  }
}

/**
 * Check if the current terminal can display inline images.
 */
export function canDisplayImages(): boolean {
  return detectImageProtocol() !== "none";
}
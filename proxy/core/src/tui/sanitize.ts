/**
 * Uptokey TUI — Terminal output sanitizer.
 * Strips dangerous ANSI/OSC sequences from model output to prevent
 * escape injection, clipboard hijacking, hyperlink spoofing, and title manipulation.
 * Requirement: 06-SEGURANCA-E-PRIVACIDADE.md row 2 (Output de ferramenta/modelo).
 */

// Dangerous sequences to strip:
// OSC 52 — clipboard write
// OSC 8  — hyperlink (can spoof URLs)
// OSC 0/1/2 — title change
// OSC 7  — current directory
// CSI sequences that aren't standard colors (cursor movement, screen clear, etc.)
// APC/PM/SOS device control

const DANGEROUS_OSC = /\x1b\](?:52|0|1|2|7);[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DANGEROUS_OSC8 = /\x1b\]8;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const APC_SOS_PM = /\x1b[_^X][^\x1b]*\x1b\\/g;
const DANGEROUS_CSI = /\x1b\[[\d;]*[ABCDEFGHJKSTfnsulhp]/g;
const DEVICE_CONTROL = /\x1b[PX][^\x1b]*\x1b\\/g;
const RAW_ESCAPE_BYTES = /[\x00-\x08\x0e-\x1a\x7f]/g;

/**
 * Sanitize text output from model/tool for safe terminal rendering.
 * Preserves standard SGR color codes (CSI...m) while stripping
 * everything else that could manipulate the terminal.
 */
export function sanitizeTerminalOutput(text: string): string {
  let result = text;

  // 1. Strip OSC clipboard, title, directory
  result = result.replace(DANGEROUS_OSC, "");

  // 2. Strip OSC 8 hyperlinks (could spoof URLs)
  result = result.replace(DANGEROUS_OSC8, "");

  // 3. Strip APC, SOS, PM sequences
  result = result.replace(APC_SOS_PM, "");

  // 4. Strip dangerous CSI (cursor movement, screen manipulation)
  // Keep only SGR (CSI...m) for colors
  result = result.replace(DANGEROUS_CSI, "");

  // 5. Strip device control sequences
  result = result.replace(DEVICE_CONTROL, "");

  // 6. Strip raw control bytes (except \t, \n, \r)
  result = result.replace(RAW_ESCAPE_BYTES, "");

  return result;
}

/**
 * Check if text contains any potentially dangerous sequences.
 * Useful for logging/alerting without modifying the text.
 */
export function containsDangerousSequences(text: string): boolean {
  // Use fresh regex instances to avoid stateful lastIndex issue with /g
  return /\x1b\](?:52|0|1|2|7);[^\x07\x1b]*(?:\x07|\x1b\\)/.test(text) ||
         /\x1b\]8;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/.test(text) ||
         /\x1b[_^X][^\x1b]*\x1b\\/.test(text) ||
         /\x1b\[[\d;]*[ABCDEFGHJKSTfnsulhp]/.test(text) ||
         /\x1b[PX][^\x1b]*\x1b\\/.test(text);
}

/**
 * Strip ALL ANSI escape sequences (for plain text output).
 */
export function stripAllAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
             .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
             .replace(/\x1b[_^X][^\x1b]*\x1b\\/g, "")
             .replace(/\x1b[PX][^\x1b]*\x1b\\/g, "");
}

/**
 * Mask secret values (API keys, tokens, passwords) for safe display in TUI and logs.
 * Preserves a short prefix and suffix when sufficiently long, or masks entirely.
 * Requirement: 06-SEGURANCA-E-PRIVACIDADE.md row 1 & row 3 (BYOK e entrada secreta mascarada).
 */
export function maskSecretValue(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "********";
  const prefix = secret.slice(0, 4);
  const suffix = secret.slice(-4);
  return `${prefix}...${suffix}`;
}


const BIDI_CONTROLS = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

/**
 * Display-safe text for the transcript renderer, applied to the whole
 * accumulated buffer (never per chunk), so a sequence split across stream
 * chunks cannot survive: every ESC-introduced sequence (CSI/OSC/DCS/APC/PM/SOS,
 * complete or truncated at the end), 8-bit C1 introducers and C0 controls other
 * than newline/tab are removed. Bidirectional overrides are made visible
 * instead of silently reordering code. The renderer applies its own styling;
 * model output never carries terminal control.
 */
export function sanitizeForDisplay(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (code === 0x1b || code === 0x9b || code === 0x9d || code === 0x90 || code === 0x9e || code === 0x9f || code === 0x98) {
      i = skipControlSequence(text, i);
      continue;
    }
    if (code === 0x0a || code === 0x09) { out += ch; i++; continue; }
    if (code === 0x0d) { i++; continue; }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) { i++; continue; }
    if (BIDI_CONTROLS.has(code)) { out += `<U+${code.toString(16).toUpperCase()}>`; i++; continue; }
    out += ch;
    i++;
  }
  return out;
}

/** Returns the index after a control sequence starting at `start` (or the end when truncated). */
function skipControlSequence(text: string, start: number): number {
  const first = text.charCodeAt(start);
  let i = start + 1;
  let kind: "csi" | "string" | "single";
  if (first === 0x9b) kind = "csi";
  else if (first === 0x9d || first === 0x90 || first === 0x9e || first === 0x9f || first === 0x98) kind = "string";
  else {
    const next = text[i];
    if (next === undefined) return i;
    if (next === "[") { kind = "csi"; i++; }
    else if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") { kind = "string"; i++; }
    else { return i + 1; }
  }
  if (kind === "csi") {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      i++;
      if (c >= 0x40 && c <= 0x7e) return i;
    }
    return i;
  }
  // String sequences end at BEL, ST (ESC \) or 8-bit ST.
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x07 || c === 0x9c) return i + 1;
    if (c === 0x1b && text[i + 1] === "\\") return i + 2;
    i++;
  }
  return i;
}

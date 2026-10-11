/**
 * Parses terminal input once while retaining incomplete sequences across
 * chunks. Pasted text is emitted as one paste event and does not become
 * Enter or Tab actions.
 */

export type KeyName =
  | "char" | "paste" | "enter" | "newline" | "tab" | "backtab" | "backspace" | "delete" | "escape"
  | "up" | "down" | "left" | "right" | "home" | "end" | "pageup" | "pagedown" | "insert"
  | "f1" | "ctrl" | "wheelup" | "wheeldown" | "mousedown" | "mouseup" | "mousemove";

export interface KeyEvent {
  name: KeyName;
  /** Printable/pasted text for char/paste; the lowercase letter for ctrl/alt combos. */
  text: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** One-based SGR mouse position. */
  mouse?: { x: number; y: number };
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Pastes are bounded; anything larger is truncated with the remainder dropped explicitly. */
export const MAX_PASTE_BYTES = 1_048_576;

function key(name: KeyName, text = "", mods: Partial<Pick<KeyEvent, "ctrl" | "alt" | "shift" | "meta">> = {}): KeyEvent {
  return { name, text, ctrl: mods.ctrl ?? false, alt: mods.alt ?? false, shift: mods.shift ?? false, meta: mods.meta ?? false };
}

function modifiers(param: string | undefined): { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean } {
  const value = Math.max(1, Number.parseInt(param ?? "1", 10) || 1) - 1;
  return { shift: (value & 1) !== 0, alt: (value & 2) !== 0, ctrl: (value & 4) !== 0, meta: (value & 8) !== 0 };
}

const CSI_FINAL: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CSI_TILDE: Record<string, KeyName> = { "1": "home", "7": "home", "4": "end", "8": "end", "2": "insert", "3": "delete", "5": "pageup", "6": "pagedown", "11": "f1" };
const SS3_FINAL: Record<string, KeyName> = { ...CSI_FINAL, P: "f1" };

export class KeyParser {
  private pasting = false;
  private pasteBuffer = "";
  private pending = "";
  private readonly bracketedPaste: boolean;

  /** Set only after the terminal's bracketed-paste mode has been enabled. */
  constructor(options: { bracketedPaste?: boolean } = {}) {
    this.bracketedPaste = options.bracketedPaste === true;
  }

  /** Feeds one chunk; returns complete events. Incomplete escapes wait for the next chunk. */
  feed(chunk: string): KeyEvent[] {
    let data = this.pending + chunk;
    this.pending = "";
    const events: KeyEvent[] = [];
    while (data.length) {
      if (this.pasting) {
        const end = data.indexOf(PASTE_END);
        if (end < 0) {
          // Keep a possible partial terminator for the next chunk.
          const keep = partialSuffix(data, PASTE_END);
          this.appendPaste(data.slice(0, data.length - keep));
          this.pending = data.slice(data.length - keep);
          return events;
        }
        this.appendPaste(data.slice(0, end));
        events.push(key("paste", normalizeNewlines(this.pasteBuffer)));
        this.pasteBuffer = "";
        this.pasting = false;
        data = data.slice(end + PASTE_END.length);
        continue;
      }
      if (data.startsWith(PASTE_START)) { this.pasting = true; data = data.slice(PASTE_START.length); continue; }
      if (data[0] === "\x1b") {
        const parsed = this.parseEscape(data);
        if (!parsed) { this.pending = data; return events; }
        if (parsed.event) events.push(parsed.event);
        data = data.slice(parsed.consumed);
        continue;
      }
      // Plain run up to the next escape.
      const next = data.indexOf("\x1b");
      const run = next < 0 ? data : data.slice(0, next);
      data = next < 0 ? "" : data.slice(next);
      events.push(...this.parsePlain(run));
    }
    return events;
  }

  /** True while an escape prefix waits for more bytes (callers flush after a short delay). */
  get hasPending(): boolean { return !this.pasting && this.pending.length > 0; }

  /** A lone ESC left pending (no follow-up bytes) is a real Escape key. */
  flush(): KeyEvent[] {
    const pending = this.pending;
    if (this.pasting || !pending) return [];
    this.pending = "";
    if (pending === "\x1b") return [key("escape")];
    if (pending.length === 2 && pending.codePointAt(1)! >= 0x20) return [key("char", pending[1]!, { alt: true })];
    return [];
  }

  private appendPaste(text: string): void {
    if (this.pasteBuffer.length + text.length > MAX_PASTE_BYTES) {
      this.pasteBuffer += text.slice(0, Math.max(0, MAX_PASTE_BYTES - this.pasteBuffer.length));
    } else {
      this.pasteBuffer += text;
    }
  }

  private parsePlain(run: string): KeyEvent[] {
    // Legacy terminals cannot distinguish paste from coalesced keystrokes.
    // With bracketed paste enabled, markers own paste and an ordinary CR is Enter.
    if (!this.bracketedPaste && run.length > 1 && /[\r\n]/.test(run) && /[^\r\n]/.test(run)) return [key("paste", normalizeNewlines(run))];
    const events: KeyEvent[] = [];
    let text = "";
    const flushText = () => { if (text) { events.push(key("char", text)); text = ""; } };
    for (const ch of run) {
      const code = ch.codePointAt(0)!;
      if (ch === "\r") { flushText(); events.push(key("enter")); continue; }
      if (ch === "\n") { flushText(); events.push(key("newline", "", { ctrl: true })); continue; }
      if (ch === "\t") { flushText(); events.push(key("tab")); continue; }
      if (ch === "\x7f") { flushText(); events.push(key("backspace")); continue; }
      if (ch === "\b") { flushText(); events.push(key("backspace", "", { ctrl: true })); continue; }
      if (code === 0) { flushText(); continue; }
      if (code < 0x20) { flushText(); events.push(key("ctrl", String.fromCharCode(code + 96), { ctrl: true })); continue; }
      if (code >= 0x80 && code < 0xa0) { flushText(); continue; }
      text += ch;
    }
    flushText();
    return events;
  }

  private parseEscape(data: string): { event: KeyEvent | null; consumed: number } | null {
    if (data.length === 1) return null;
    const second = data[1]!;
    if (second === "[") {
      // CSI: parameters then a final byte in 0x40..0x7e.
      let i = 2;
      while (i < data.length && /[0-9;:<=>?]/.test(data[i]!)) i++;
      if (i >= data.length) return data.length > 64 ? { event: null, consumed: data.length } : null;
      const final = data[i]!;
      const params = data.slice(2, i);
      const consumed = i + 1;
      if (params.startsWith("<")) {
        // XTerm SGR 1006
        const match = /^<(\d+);(\d+);(\d+)$/.exec(params);
        if (!match || (final !== "M" && final !== "m")) return { event: null, consumed };
        const [button, x, y] = match.slice(1).map(Number) as [number, number, number];
        if (!Number.isSafeInteger(button) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < 1) return { event: null, consumed };
        const mods = { shift: (button & 4) !== 0, alt: (button & 8) !== 0, ctrl: (button & 16) !== 0 };
        const baseButton = button & ~28;
        if (baseButton === 64 || baseButton === 65) {
          if (final !== "M") return { event: null, consumed };
          return { event: { ...key((baseButton & 1) === 0 ? "wheelup" : "wheeldown", "", mods), mouse: { x, y } }, consumed };
        }
        if (final === "m" || baseButton === 3) {
          return { event: { ...key("mouseup", "", mods), mouse: { x, y } }, consumed };
        }
        if (baseButton === 32) {
          return { event: { ...key("mousemove", "", mods), mouse: { x, y } }, consumed };
        }
        if (baseButton === 0) {
          return { event: { ...key("mousedown", "", mods), mouse: { x, y } }, consumed };
        }
        return { event: null, consumed };
      }
      if (params.startsWith("?")) return { event: null, consumed }; // capabilities query response e.g. CSI ? flags u
      const parts = params.split(";");
      if (final === "~") {
        if (parts[0] === "27" && parts[2] === "13") return { event: key("newline", "", modifiers(parts[1])), consumed };
        const name = CSI_TILDE[parts[0] ?? ""];
        return { event: name ? key(name, "", modifiers(parts[1])) : null, consumed };
      }
      if (final === "u") {
        const code = Number.parseInt(parts[0] ?? "", 10);
        const mods = modifiers(parts[1]);
        if (code === 13) return { event: key(mods.shift || mods.alt || mods.ctrl ? "newline" : "enter", "", mods), consumed };
        if (code === 27) return { event: key("escape", "", mods), consumed };
        if (code === 9) return { event: key(mods.shift ? "backtab" : "tab", "", mods), consumed };
        if (code === 127) return { event: key("backspace", "", mods), consumed };
        if (Number.isSafeInteger(code) && code > 31) {
          const text = String.fromCodePoint(code);
          return { event: mods.ctrl ? key("ctrl", text.toLowerCase(), mods) : key("char", text, mods), consumed };
        }
        return { event: null, consumed };
      }
      if (final === "Z") return { event: key("backtab", "", { shift: true }), consumed };
      if (final === "I" || final === "O") return { event: null, consumed }; // focus in/out
      const name = CSI_FINAL[final];
      return { event: name ? key(name, "", modifiers(parts.length > 1 ? parts[1] : undefined)) : null, consumed };
    }
    if (second === "O") {
      if (data.length < 3) return null;
      const name = SS3_FINAL[data[2]!];
      return { event: name ? key(name) : null, consumed: 3 };
    }
    if (second === "\r" || second === "\n") return { event: key("newline", "", { alt: true }), consumed: 2 };
    if (second === "\x7f" || second === "\b") return { event: key("backspace", "", { alt: true }), consumed: 2 };
    if (second === "\x1b") return { event: key("escape"), consumed: 1 };
    const code = second.codePointAt(0)!;
    if (code >= 0x20) {
      const ch = String.fromCodePoint(code);
      return { event: key("char", ch, { alt: true }), consumed: ch.length + 1 };
    }
    return { event: key("escape"), consumed: 1 };
  }
}

function partialSuffix(data: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, data.length); n > 0; n--) {
    if (marker.startsWith(data.slice(data.length - n))) return n;
  }
  return 0;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Human-readable name used by the command registry and the help view. */
export function describeKey(event: KeyEvent): string {
  const mods = [event.meta ? "Cmd" : "", event.ctrl ? "Ctrl" : "", event.alt ? "Alt" : "", event.shift ? "Shift" : ""].filter(Boolean);
  const base = event.name === "ctrl" || event.name === "char" ? event.text.toUpperCase() : event.name;
  return [...mods, base].join("+");
}

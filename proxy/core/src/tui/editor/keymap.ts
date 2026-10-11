/** Selection-first key bindings. No commands execute outside EditorView's dispatcher. */
import type { EditorMode, Direction } from "./buffer.ts";
export type EditorAction =
  | { type: "move"; direction: Direction; extend: boolean }
  | { type: "move_word"; forward: boolean; extend: boolean }
  | { type: "insert"; text: string }
  | { type: "enter_mode"; mode: EditorMode }
  | { type: "goto_line"; line: number }
  | { type: "backspace" | "delete_word" | "delete_char" | "newline" | "undo" | "redo" | "select_word" | "select_line" | "select_all" | "delete_selection" | "change_selection" | "yank" | "paste" | "save" | "quit" | "command_mode" | "search" | "search_next" | "add_match" | "all_matches" | "keep_primary" | "expand" | "shrink" | "append" | "focus_pane" | "none" | "add_cursor_up" | "add_cursor_down" };
export interface KeyEvent {
  input: string;
  key: { return: boolean; escape: boolean; ctrl: boolean; shift: boolean; meta: boolean; backspace: boolean; delete: boolean; tab: boolean; upArrow: boolean; downArrow: boolean; leftArrow: boolean; rightArrow: boolean; pageDown: boolean; pageUp: boolean; home?: boolean; end?: boolean };
}
export function mapKey(mode: EditorMode, { input, key }: KeyEvent): EditorAction {
  if (key.escape) return mode === "normal" ? { type: "keep_primary" } : { type: "enter_mode", mode: "normal" };
  if (key.ctrl && key.meta) {
    if (key.upArrow) return { type: "add_cursor_up" };
    if (key.downArrow) return { type: "add_cursor_down" };
  }
  if (key.ctrl) {
    if (input === "s") return { type: "save" };
    if (input === "z") return { type: "undo" };
    if (input === "y" || input === "r") return { type: "redo" };
    if (input === "d") return { type: "add_match" };
    if (input === "l" && key.shift) return { type: "all_matches" };
    if (input === "w") return { type: "delete_word" };
    if (input === "a") return { type: "move", direction: "home", extend: mode === "select" };
    if (input === "e") return { type: "move", direction: "end", extend: mode === "select" };
    if (input === "u") return { type: "move", direction: "pageup", extend: mode === "select" };
    // 'd' was page down, so we re-map 'f' or leave it to 'pagedown' key
    return { type: "none" };
  }
  if (key.meta) {
    if (input === "o" || input === "s") return { type: "expand" };
    if (input === "i" || input === "S") return { type: "shrink" };
    if (input === "a") return { type: "all_matches" };
    if (key.rightArrow) return { type: "move_word", forward: true, extend: mode === "select" };
    if (key.leftArrow) return { type: "move_word", forward: false, extend: mode === "select" };
    return { type: "none" };
  }
  const direction: Direction | undefined = key.leftArrow ? "left" : key.rightArrow ? "right" : key.upArrow ? "up" : key.downArrow ? "down" : key.home ? "home" : key.end ? "end" : key.pageUp ? "pageup" : key.pageDown ? "pagedown" : undefined;
  if (direction) return { type: "move", direction, extend: mode === "select" || key.shift };
  if (key.escape) return mode === "normal" ? { type: "keep_primary" } : { type: "enter_mode", mode: "normal" };
  if (mode === "insert") {
    if (key.delete) return { type: "delete_char" };
    if (key.backspace) return { type: "backspace" };
    if (key.return) return { type: "newline" };
    if (key.tab) return { type: "insert", text: "  " };
    return input ? { type: "insert", text: input } : { type: "none" };
  }
  if (key.tab) return { type: "focus_pane" };
  if (input === "i") return { type: "enter_mode", mode: "insert" };
  if (input === "a") return { type: "append" };
  if (input === "v") return { type: "enter_mode", mode: mode === "select" ? "normal" : "select" };
  const moves: Record<string, Direction> = { h: "left", j: "down", k: "up", l: "right", "0": "home", "$": "end" };
  if (moves[input]) return { type: "move", direction: moves[input]!, extend: mode === "select" };
  if (input === "b") return { type: "move_word", forward: false, extend: mode === "select" };
  const actions: Record<string, EditorAction["type"]> = {
    u: "undo", U: "redo", x: key.shift ? "select_line" : "delete_char", X: "select_line", w: "select_word",
    d: "delete_selection", c: "change_selection", y: "yank", p: "paste", "%": "select_all",
    ",": "keep_primary", n: "search_next", ":": "command_mode", "/": "search", q: "quit",
  };
  return { type: actions[input] ?? "none" } as EditorAction;
}

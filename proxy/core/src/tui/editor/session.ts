/** Ephemeral buffers and split state. App owns one session per exact project/root.
 * Contains neither filesystem writes nor persistent caches, including temporary mode. */
import { Buffer, type Selection } from "./buffer.ts";
import { EditorSyntax } from "./syntax.ts";
import type { EditorSaveOperation } from "../editor-save.ts";
export interface EditorDocument {
  buffer: Buffer; syntax: EditorSyntax; diskHash: string | null;
  operation?: EditorSaveOperation; saving: boolean;
}
export interface EditorPane { path: string; selections: Selection[]; scroll: number; column: number; snapshot: string }
interface EditorJump { path: string; selections: Selection[]; scroll: number; column: number }
export class EditorSession {
  readonly documents = new Map<string, EditorDocument>();
  panes: EditorPane[] = [];
  activePane = 0;
  splitDirection: "vertical" | "horizontal" = "vertical";
  register: string[] = [];
  search = "";
  private backward: EditorJump[] = [];
  private forward: EditorJump[] = [];
  readonly contextKey: string;
  constructor(contextKey = "") { this.contextKey = contextKey; }
  get current(): EditorDocument | undefined { return this.documents.get(this.panes[this.activePane]?.path ?? ""); }
  get dirty(): boolean { return [...this.documents.values()].some(d => d.buffer.modified); }
  get busy(): boolean { return [...this.documents.values()].some(d => d.saving); }
  get jumpCounts(): { back: number; forward: number } { return { back: this.backward.length, forward: this.forward.length }; }
  private location(): EditorJump | null {
    const pane = this.panes[this.activePane], doc = this.current;
    return pane && doc ? { path: pane.path, selections: [...doc.buffer.selections], scroll: pane.scroll, column: pane.column } : null;
  }
  rememberJump(): void {
    const current = this.location(); if (!current) return;
    if (JSON.stringify(this.backward.at(-1)) !== JSON.stringify(current)) this.backward.push(current);
    if (this.backward.length > 128) this.backward.shift(); this.forward = [];
  }
  jumpTo(path: string, selections: readonly Selection[]): boolean {
    if (!this.documents.has(path)) return false;
    this.rememberJump(); this.activate(path); this.current!.buffer.setSelections(selections); this.capture(); return true;
  }
  jumpBack(): boolean { return this.restoreJump(this.backward, this.forward); }
  jumpForward(): boolean { return this.restoreJump(this.forward, this.backward); }
  private restoreJump(source: EditorJump[], destination: EditorJump[]): boolean {
    let target: EditorJump | undefined;
    while ((target = source.pop())) {
      if (!this.documents.has(target.path)) continue;
      const current = this.location(); if (current) destination.push(current);
      this.activate(target.path); this.current!.buffer.setSelections(target.selections);
      const pane = this.panes[this.activePane]!; pane.scroll = target.scroll; pane.column = target.column; this.capture(); return true;
    }
    return false;
  }
  open(path: string, text: string, sha256: string | null): EditorDocument {
    let doc = this.documents.get(path);
    if (!doc) { doc = { buffer: new Buffer(path, text), syntax: new EditorSyntax(path), diskHash: sha256, saving: false }; this.documents.set(path, doc); }
    this.activate(path); return doc;
  }
  capture(): void {
    const active = this.panes[this.activePane], doc = this.current; if (!active || !doc) return;
    const next = doc.buffer.getText();
    const mapSelections = (old: string, selections: readonly Selection[]): Selection[] => {
      const oldBuffer = new Buffer(active.path, old);
      let from = 0, oldEnd = old.length, newEnd = next.length;
      while (from < oldEnd && from < newEnd && old[from] === next[from]) from++;
      while (oldEnd > from && newEnd > from && old[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
      const map = (offset: number) => offset < from ? offset : offset >= oldEnd ? offset + newEnd - oldEnd : newEnd;
      return selections.map(s => ({ anchor: doc.buffer.positionAt(map(oldBuffer.offsetAt(s.anchor))), head: doc.buffer.positionAt(map(oldBuffer.offsetAt(s.head))) }));
    };
    if (active.snapshot !== next) for (const jump of [...this.backward, ...this.forward]) {
      if (jump.path === active.path) jump.selections = mapSelections(active.snapshot, jump.selections);
    }
    for (const pane of this.panes) {
      if (pane.path !== active.path || pane === active || pane.snapshot === next) continue;
      pane.selections = mapSelections(pane.snapshot, pane.selections);
      pane.snapshot = next;
    }
    active.selections = [...doc.buffer.selections]; active.snapshot = next;
  }
  activate(path: string): boolean {
    const doc = this.documents.get(path); if (!doc) return false;
    this.capture();
    if (!this.panes.length) this.panes.push({ path, selections: [...doc.buffer.selections], scroll: 0, column: 0, snapshot: doc.buffer.getText() });
    else this.panes[this.activePane] = { path, selections: [...doc.buffer.selections], scroll: 0, column: 0, snapshot: doc.buffer.getText() };
    return true;
  }
  cycleBuffer(delta: number): void {
    const paths = [...this.documents.keys()], current = paths.indexOf(this.current?.buffer.path ?? "");
    if (paths.length > 1) { this.rememberJump(); this.activate(paths[(current + delta + paths.length) % paths.length]!); }
  }
  split(direction: "vertical" | "horizontal"): boolean {
    this.capture(); const pane = this.panes[this.activePane]; if (!pane) return false;
    this.splitDirection = direction;
    if (this.panes.length < 2) this.panes.push({ ...pane, selections: pane.selections.map(s => ({ anchor: { ...s.anchor }, head: { ...s.head } })) });
    this.focusPane(1); return true;
  }
  focusPane(index: number): void {
    this.capture(); this.activePane = Math.max(0, Math.min(index, this.panes.length - 1));
    const pane = this.panes[this.activePane]; if (pane) this.current?.buffer.setSelections(pane.selections);
  }
  only(): void { this.capture(); const pane = this.panes[this.activePane]; this.panes = pane ? [pane] : []; this.activePane = 0; }
  closeBuffer(path: string, discard = false): boolean {
    const doc = this.documents.get(path); if (!doc || doc.saving || (doc.buffer.modified && !discard)) return false;
    this.documents.delete(path);
    const fallback = this.documents.keys().next().value as string | undefined;
    this.panes = this.panes.flatMap(p => p.path !== path ? [p] : fallback ? [{ path: fallback, selections: [...this.documents.get(fallback)!.buffer.selections], scroll: 0, column: 0, snapshot: this.documents.get(fallback)!.buffer.getText() }] : []);
    this.activePane = Math.min(this.activePane, Math.max(0, this.panes.length - 1)); return true;
  }
}

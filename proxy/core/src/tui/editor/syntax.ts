/** Incremental JS/TS/JSX/TSX and JSON syntax via Lezer (MIT). Other languages
 * explicitly use the existing visual tokenizer; structural selection is unavailable. */
import { TreeFragment, type Parser, type Tree, type SyntaxNode } from "@lezer/common";
import { parser as javascript } from "@lezer/javascript";
import { parser as json } from "@lezer/json";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { detectLanguage, tokenizeLine, type Token } from "./highlight.ts";
import type { Buffer } from "./buffer.ts";
const colors = tagHighlighter([
  { tag: tags.keyword, class: "magenta" }, { tag: tags.string, class: "green" },
  { tag: [tags.number, tags.bool, tags.null], class: "yellow" },
  { tag: tags.comment, class: "gray" }, { tag: [tags.typeName, tags.propertyName], class: "cyan" },
  { tag: [tags.operator, tags.punctuation], class: "yellow" },
]);
export interface EditorSymbol { name: string; kind: string; from: number; to: number; line: number }
export class EditorSyntax {
  private parser: Parser | null;
  private tree: Tree | null = null;
  private fragments: readonly TreeFragment[] = [];
  private previous = "";
  private version = -1;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    const ext = path.split(".").pop()?.toLowerCase();
    this.parser = ext === "json" ? json : /^(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(ext ?? "")
      ? javascript.configure({ dialect: `${/tsx?|[cm]ts/.test(ext!) ? "ts" : ""} ${/[jt]sx/.test(ext!) ? "jsx" : ""}`.trim() }) : null;
  }
  get label(): string { return this.parser ? this.tree ? "Lezer incremental" : "Lezer (arquivo grande: destaque simples)" : "destaque simples; sem parser estrutural"; }
  update(buffer: Buffer): void {
    if (buffer.version === this.version) return;
    const next = buffer.getText(); this.version = buffer.version;
    if (!this.parser || next.length > 2 * 1024 * 1024) { this.tree = null; this.fragments = []; this.previous = next; return; }
    if (this.tree) {
      let from = 0, oldEnd = this.previous.length, newEnd = next.length;
      while (from < oldEnd && from < newEnd && this.previous[from] === next[from]) from++;
      while (oldEnd > from && newEnd > from && this.previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
      this.fragments = TreeFragment.applyChanges(this.fragments, [{ fromA: from, toA: oldEnd, fromB: from, toB: newEnd }]);
    }
    this.tree = this.parser.parse(next, this.fragments); this.fragments = TreeFragment.addTree(this.tree); this.previous = next;
  }
  expand(from: number, to: number): { from: number; to: number } | null {
    if (!this.tree) return null;
    let node: SyntaxNode | null = this.tree.resolveInner(from, 1);
    while (node) {
      if (node.from <= from && node.to >= to && (node.from < from || node.to > to) && !node.type.isError) return { from: node.from, to: node.to };
      node = node.parent;
    }
    return null;
  }
  /** Definitions come from grammar nodes, never from matching source text. */
  symbols(buffer: Buffer): EditorSymbol[] {
    this.update(buffer); if (!this.tree) return [];
    const found: EditorSymbol[] = [];
    const kinds: Record<string, string> = { FunctionDeclaration: "função", AmbientFunctionDeclaration: "função", ClassDeclaration: "classe", VariableDeclaration: "variável", TypeAliasDeclaration: "tipo", InterfaceDeclaration: "interface", EnumDeclaration: "enum", NamespaceDeclaration: "namespace", MethodDeclaration: "método", PropertyDeclaration: "propriedade", Property: "chave" };
    this.tree.iterate({ enter: ref => {
      if (found.length >= 1000) return false;
      if (!["VariableDefinition", "TypeDefinition", "PropertyDefinition", "PrivatePropertyDefinition", "PropertyName"].includes(ref.name)) return;
      let parent = ref.node.parent;
      while (parent && ["ObjectPattern", "ArrayPattern", "PatternProperty", "TypedPattern"].includes(parent.name)) parent = parent.parent;
      const kind = parent ? kinds[parent.name] : undefined;
      if (kind) found.push({ name: buffer.getText().slice(ref.from, ref.to), kind, from: ref.from, to: ref.to, line: buffer.positionAt(ref.from).line });
    } });
    return found;
  }
  line(buffer: Buffer, line: number): Token[] {
    this.update(buffer);
    if (!this.tree) { const raw = buffer.getLine(line); return [...tokenizeLine(raw.slice(0, 32768), detectLanguage(this.path)), ...(raw.length > 32768 ? [{ text: raw.slice(32768), color: "white" }] : [])]; }
    const from = buffer.offsetAt({ line, col: 0 }), text = buffer.getLine(line), to = from + text.length;
    const tokens: Token[] = []; let last = from;
    highlightTree(this.tree, colors, (a, b, color) => {
      a = Math.max(a, from); b = Math.min(b, to);
      if (a > last) tokens.push({ text: this.previous.slice(last, a), color: "white" });
      if (b > a) tokens.push({ text: this.previous.slice(a, b), color, ...(color === "gray" ? { dimColor: true } : {}) });
      last = b;
    }, from, to);
    if (last < to) tokens.push({ text: this.previous.slice(last, to), color: "white" });
    return tokens;
  }
}

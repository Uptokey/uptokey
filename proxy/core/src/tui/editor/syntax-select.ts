import { parser as javascript } from "@lezer/javascript";
import { parser as json } from "@lezer/json";

export interface Range { from: number; to: number }

function getParser(lang: 'js' | 'ts' | 'json') {
  if (lang === 'json') return json;
  return javascript.configure({ dialect: lang === 'ts' ? "ts" : "" });
}

export function expandSelection(source: string, lang: 'js' | 'ts' | 'json', selection: Range): Range {
  const parser = getParser(lang);
  const tree = parser.parse(source);
  let node = tree.resolveInner(selection.from, 1);
  while (node) {
    if (node.from <= selection.from && node.to >= selection.to && (node.from < selection.from || node.to > selection.to) && !node.type.isError) {
      return { from: node.from, to: node.to };
    }
    const parent = node.parent;
    if (!parent) break;
    node = parent;
  }
  return selection;
}

export function shrinkSelection(source: string, lang: 'js' | 'ts' | 'json', selection: Range): Range {
  // Shrinking structurally requires a history in EditorView/buffer.
  // This stateless API can only guess the first child that encompasses the center, which is not robust.
  // However, EditorView uses the stateful buffer.shrinkSelections().
  return selection;
}

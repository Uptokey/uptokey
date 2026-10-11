/**
 * Finds (and with --apply wraps) the user-visible English strings of the vendored OpenCode interface so they can be
 * translated by key: JSX text, selected string props (title, placeholder, …) and string values of selected object
 * keys. The transform is idempotent and re-runnable on a fresh upstream copy.
 *
 *   bun scripts/localize-vendor.mjs            # report: writes uptokey/vendor-strings.json
 *   bun scripts/localize-vendor.mjs --apply    # wraps the strings with tr("…") and adds the import
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const vendor = path.join(root, "vendor", "opencode-tui");
const apply = process.argv.includes("--apply");

const PROPS = new Set(["title", "placeholder", "label", "message", "description", "footer", "hint", "emptyText", "pending", "failure", "header", "subtitle", "desc", "category"]);
const SKIP_FILES = [/[\\/]theme[\\/]/, /util[\\/]filetype/, /\.d\.ts$/, /feature-plugins[\\/]system[\\/]diff-viewer-file-tree-utils/];
const SKIP_PATH_PREFIX = []; // add directories that must never be wrapped

const found = new Map(); // text -> Set(files)

function interesting(text, jsx = false) {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length < 2 || value.length > 200) return null;
  if (!/[A-Za-z]{2,}/.test(value)) return null;
  // Identifiers, paths and keybind names are not text; a lowercase word between JSX tags is ("commands", "submit").
  if (!jsx && /^[a-z0-9_.:/@#-]+$/.test(value) && !/\s/.test(value) && !/^[A-Z]/.test(value)) return null;
  if (jsx && /^[a-z0-9_.:/@#-]+$/.test(value) && /[:/@#_]/.test(value)) return null;
  if (/^(https?:|\/|\.\/|[a-z]+:\/\/)/i.test(value)) return null;
  return value;
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(tsx|ts)$/.test(entry.name) && !SKIP_FILES.some((pattern) => pattern.test(full))) out.push(full);
  }
  return out;
}

function record(text, file) {
  if (!found.has(text)) found.set(text, new Set());
  found.get(text).add(path.relative(vendor, file).replaceAll("\\", "/"));
}

function transformFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const edits = []; // { start, end, text }
  const jsxChildContext = (node) => {
    // Never wrap text inside <code>, <diff>, <markdown>-like content; only UI chrome.
    let current = node.parent;
    while (current) {
      if (ts.isJsxElement(current)) {
        const tag = current.openingElement.tagName.getText();
        if (["markdown", "code", "diff", "textarea"].includes(tag)) return false;
      }
      current = current.parent;
    }
    return true;
  };

  function visit(node) {
    if (ts.isJsxText(node) && jsxChildContext(node)) {
      const raw = node.getText();
      const trimmed = raw.replace(/\s+/g, " ").trim();
      const value = interesting(trimmed, true);
      if (value) {
        record(value, file);
        const leading = /^[ \t]+/.test(raw) && !/^\s*\n/.test(raw);
        const trailing = /[ \t]+$/.test(raw) && !/\n\s*$/.test(raw);
        const replacement = `${leading ? '{" "}' : ""}{tr(${JSON.stringify(value)})}${trailing ? '{" "}' : ""}`;
        // Keep line structure: preserve leading/trailing newlines.
        const head = raw.match(/^\s*\n\s*/)?.[0] ?? "";
        const tail = raw.match(/\s*\n\s*$/)?.[0] ?? "";
        edits.push({ start: node.getStart(sf, true), end: node.getEnd(), text: `${head}${replacement}${tail}` });
      }
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && PROPS.has(node.name.getText())) {
      const value = interesting(node.initializer.text);
      if (value) {
        record(value, file);
        edits.push({ start: node.initializer.getStart(sf), end: node.initializer.getEnd(), text: `{tr(${JSON.stringify(node.initializer.text)})}` });
      }
    } else if (ts.isConditionalExpression(node) && node.parent && ts.isJsxExpression(node.parent) && jsxChildContext(node)) {
      // {condition ? "text" : "other text"} as a child of a JSX element
      for (const branch of [node.whenTrue, node.whenFalse]) {
        if (!ts.isStringLiteral(branch)) continue;
        const value = interesting(branch.text, true);
        if (!value) continue;
        record(value, file);
        edits.push({ start: branch.getStart(sf), end: branch.getEnd(), text: `tr(${JSON.stringify(branch.text)})` });
      }
    } else if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer) && node.name && PROPS.has(node.name.getText().replace(/["']/g, ""))) {
      const value = interesting(node.initializer.text);
      if (value) {
        record(value, file);
        edits.push({ start: node.initializer.getStart(sf), end: node.initializer.getEnd(), text: `tr(${JSON.stringify(node.initializer.text)})` });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (!apply || edits.length === 0) return edits.length;
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  if (!/from "[^"]*uptokey\/tr(\.ts)?"/.test(out)) {
    const relative = path.relative(path.dirname(file), path.join(root, "uptokey", "tr.ts")).replaceAll("\\", "/");
    // Insert after the last complete import declaration (imports may span several lines).
    const reparsed = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true, kind);
    const lastImport = reparsed.statements.filter((statement) => ts.isImportDeclaration(statement)).at(-1);
    const insertAt = lastImport ? out.indexOf("\n", lastImport.getEnd()) + 1 : 0;
    out = `${out.slice(0, insertAt)}import { tr } from "${relative.startsWith(".") ? relative : `./${relative}`}"\n${out.slice(insertAt)}`;
  }
  fs.writeFileSync(file, out);
  return edits.length;
}

let total = 0;
for (const file of walkFiles(vendor)) total += transformFile(file);
const report = [...found.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([text, files]) => ({ text, files: [...files] }));
fs.writeFileSync(path.join(root, "uptokey", "vendor-strings.json"), JSON.stringify(report, null, 1) + "\n");
console.log(`${apply ? "wrapped" : "found"} ${total} occurrences, ${report.length} unique strings`);

/** Lists every English key passed to tr("…") in the vendored interface (source of truth for translations). */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const keys = new Map();
const CALL = /\btr\(("(?:[^"\\]|\\.)*")\)/g;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx|ts)$/.test(entry.name) && !/i18n/.test(entry.name)) {
      const text = fs.readFileSync(full, "utf8");
      for (const match of text.matchAll(CALL)) {
        const key = JSON.parse(match[1]);
        if (!keys.has(key)) keys.set(key, new Set());
        keys.get(key).add(path.relative(root, full).replaceAll("\\", "/"));
      }
    }
  }
}

walk(path.join(root, "vendor", "opencode-tui"));
walk(path.join(root, "uptokey"));
const report = [...keys.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([text, files]) => ({ text, files: [...files] }));
fs.writeFileSync(path.join(root, "uptokey", "vendor-strings.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(`${report.length} keys`);

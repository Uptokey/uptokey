/**
 * Coverage of the vendored interface strings (uptokey/vendor-strings.json) by uptokey/i18n-vendor*.ts.
 * Usage: bun scripts/i18n-report.ts [--by-file] [--missing] [--json out.json]
 * A row counts as translated for a language when its slot differs from the key or the language is English
 * (proper nouns and identical words such as "Shell" are allowed to stay the same in a few languages).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { VENDOR_ROWS, VENDOR_LANGS, VENDOR_KEEP } from "../uptokey/i18n-vendor.ts"

const root = path.resolve(import.meta.dir, "..")
const inventory = JSON.parse(readFileSync(path.join(root, "uptokey/vendor-strings.json"), "utf8")) as Array<{ text: string; files: string[] }>
const args = process.argv.slice(2)
const rows = VENDOR_ROWS as Record<string, readonly string[]>

const keep = new Set(VENDOR_KEEP)
const kept = inventory.filter((entry) => !rows[entry.text] && keep.has(entry.text))
const missing = inventory.filter((entry) => !rows[entry.text] && !keep.has(entry.text))
const byFile: Record<string, number> = {}
for (const entry of missing) for (const file of entry.files) byFile[file] = (byFile[file] ?? 0) + 1
const perLang = Object.fromEntries(VENDOR_LANGS.map((lang, index) => [lang, inventory.filter((entry) => rows[entry.text]?.[index]).length]))

// Key binding descriptions (config/keybind.ts) are shown by the which-key overlay for bindings without a command
// title; they are looked up through tr() but are not part of the wrapped-literal inventory, so count them apart.
const keybindSource = readFileSync(path.join(root, "vendor/opencode-tui/config/keybind.ts"), "utf8")
const keybindDescriptions = [...keybindSource.matchAll(/keybind\([^\n]*?,\s*("(?:[^"\\]|\\.)*")\)/g)].map((match) => JSON.parse(match[1]!) as string)
const keybindMissing = [...new Set(keybindDescriptions)].filter((text) => !rows[text])
const unused = Object.keys(rows).filter((key) => !inventory.some((entry) => entry.text === key) && !keybindDescriptions.includes(key))

// Every ui("key") literal in Uptokey's own frontend code must resolve to a frontend row/string or a shared TUI key in
// all ten languages (a missing key would show the raw key on screen).
const { STRINGS } = await import("../uptokey/i18n.ts")
const { ROWS } = await import("../uptokey/i18n-rows.ts")
const { messages: sharedEn } = await import("../../messages/en.ts")
const uiKeys = new Set<string>()
function scan(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) scan(full)
    else if (/\.(ts|tsx)$/.test(entry.name)) for (const match of readFileSync(full, "utf8").matchAll(/\bui\("([A-Za-z0-9_.-]+)"/g)) uiKeys.add(match[1]!)
  }
}
scan(path.join(root, "uptokey"))
scan(path.join(root, "vendor", "opencode-tui"))
const uiMissing = [...uiKeys].filter((key) => !(key in STRINGS) && !(key in ROWS) && !(key in (sharedEn as Record<string, string>)))

const report = {
  uiKeys: { total: uiKeys.size, missing: uiMissing },
  keybindDescriptions: { total: new Set(keybindDescriptions).size, missing: keybindMissing.length },
  total: inventory.length,
  translated: inventory.length - missing.length - kept.length,
  keptAsWritten: kept.length,
  missing: missing.length,
  perLanguage: perLang,
  unusedRows: unused,
  missingByFile: byFile,
  ...(args.includes("--missing") ? { missingStrings: missing.map((entry) => entry.text) } : {}),
}
const jsonIndex = args.indexOf("--json")
if (jsonIndex >= 0) writeFileSync(args[jsonIndex + 1]!, JSON.stringify(report, null, 1))
if (args.includes("--by-file")) {
  for (const [file, count] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) console.log(String(count).padStart(4), file.replace("vendor/opencode-tui/", ""))
}
if (args.includes("--keybind-missing")) for (const text of keybindMissing) console.log(JSON.stringify(text))
if (args.includes("--missing")) for (const entry of missing) console.log(JSON.stringify(entry.text), "\t", entry.files.map((file) => file.replace("vendor/opencode-tui/", "")).join(","))
console.log(JSON.stringify({ total: report.total, translated: report.translated, kept: kept.length, missing: report.missing, keybindDescriptions: report.keybindDescriptions, uiKeysMissing: uiMissing, unused: unused }))
if (args.includes("--strict") && (missing.length > 0 || uiMissing.length > 0)) process.exit(1)

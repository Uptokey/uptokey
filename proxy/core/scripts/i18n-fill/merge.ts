/**
 * Completes the shared TUI dictionaries (src/tui/messages/<lang>.ts) so every language carries every key.
 * Policy (CO-TUI-03): ten complete languages for everything a person reads; model-facing instructions (system_*)
 * stay in English in every dictionary on purpose (the model answers in the person's language).
 *   bun scripts/i18n-fill/merge.ts [--check]
 * Missing keys are appended before the closing brace; a value that is still the Portuguese text in another
 * language is replaced on its own line. Other lines are left untouched (concurrent edits elsewhere survive).
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { FILL_1 } from "./fill-1.ts"
import { FILL_2 } from "./fill-2.ts"
import { FILL_3 } from "./fill-3.ts"
import { FILL_4 } from "./fill-4.ts"
import { FILL_5, FILL_5_MORE, FILL_5_STATUS } from "./fill-5.ts"

const LANGS = ["es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"] as const
const root = path.resolve(import.meta.dir, "../../src/tui/messages")
const rows: Record<string, readonly string[]> = { ...FILL_1, ...FILL_2, ...FILL_3, ...FILL_4, ...FILL_5, ...FILL_5_STATUS, ...FILL_5_MORE }
const check = process.argv.includes("--check")

const load = async (lang: string) => (await import(path.join(root, `${lang}.ts`))).messages as Record<string, string>
const en = await load("en")
const pt = await load("pt-BR")
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",")
const keyLiteral = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key))
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

let problems = 0
for (const [index, lang] of LANGS.entries()) {
  const file = path.join(root, `${lang}.ts`)
  const dict = await load(lang)
  let source = readFileSync(file, "utf8")
  const crlf = source.includes("\r\n")
  if (crlf) source = source.replace(/\r\n/g, "\n")
  const append: string[] = []
  let replaced = 0
  for (const key of Object.keys(en)) {
    const english = en[key]!
    const current = dict[key]
    const stillPortuguese = current !== undefined && current === pt[key] && current !== english && /[a-zà-ú]{4}/i.test(current)
    if (current !== undefined && !stillPortuguese) continue
    const wanted = key.startsWith("system_") ? english : rows[key]?.[index]
    if (wanted === undefined) {
      problems++
      console.log(`${lang}: no translation for ${key}`)
      continue
    }
    if (placeholders(wanted) !== placeholders(english)) {
      problems++
      console.log(`${lang}: placeholders differ for ${key}`)
      continue
    }
    if (current === undefined) append.push(`  ${keyLiteral(key)}: ${JSON.stringify(wanted)},`)
    else {
      const line = new RegExp(`^(\\s*)("?)${escape(key)}\\2:\\s*.*$`, "m")
      if (!line.test(source)) {
        problems++
        console.log(`${lang}: cannot locate the line of ${key}`)
        continue
      }
      source = source.replace(line, (_all, indent: string, quote: string) => `${indent}${quote}${key}${quote}: ${JSON.stringify(wanted)},`)
      replaced++
    }
  }
  if (append.length) {
    const end = source.lastIndexOf("};")
    source = `${source.slice(0, end).replace(/,?\s*$/, ",\n")}  // Completed by scripts/i18n-fill/merge.ts (CO-TUI-03: ten complete languages)\n${append.join("\n")}\n${source.slice(end)}`
  }
  console.log(`${lang}: +${append.length} keys, ${replaced} Portuguese leftovers replaced`)
  if (!check && (append.length || replaced)) writeFileSync(file, crlf ? source.replace(/\n/g, "\r\n") : source)
}
if (problems) {
  console.log(`${problems} problem(s)`)
  process.exit(1)
}

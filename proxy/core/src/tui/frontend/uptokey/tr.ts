/**
 * Runtime lookup for the user-visible strings of the vendored interface (wrapped by scripts/localize-vendor.mjs).
 * The English source text is the key; a missing translation shows the English text, and the coverage report
 * (scripts/i18n-report.ts) lists what is still missing per language.
 */
import { getLang } from "../../i18n.ts"
import { VENDOR_ROWS, VENDOR_LANGS } from "./i18n-vendor.ts"

export function tr(text: string): string {
  const row = (VENDOR_ROWS as Record<string, readonly string[]>)[text]
  if (!row) return text
  const index = VENDOR_LANGS.indexOf(getLang() as (typeof VENDOR_LANGS)[number])
  return index >= 0 ? (row[index] ?? text) : text
}

/** BCP 47 tag for Intl formatting in the interface language (Latin digits in Arabic, matching code and paths). */
export function intlLocale(): string {
  const lang = getLang()
  return lang === "ar" ? "ar-u-nu-latn" : lang
}

/** Date label for lists (session list groups) in the interface language. */
export function localDate(input: number): string {
  return new Date(input).toLocaleDateString(intlLocale(), { weekday: "short", day: "numeric", month: "short", year: "numeric" })
}

/**
 * Translations of the vendored interface strings, keyed by the English source text. One row per key with ten
 * translations in VENDOR_LANGS order (the tuple type makes a missing language a compile error). Keys come from
 * uptokey/vendor-strings.json (scripts/localize-vendor.mjs).
 */
import type { Lang } from "../../i18n.ts"

export const VENDOR_LANGS = ["pt-BR", "en", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"] as const satisfies readonly Lang[]

type Ten = readonly [string, string, string, string, string, string, string, string, string, string]

import { CHROME_ROWS } from "./i18n-vendor-chrome.ts"
import { REST_ROWS, VENDOR_KEEP } from "./i18n-vendor-rest.ts"
import { KEYBIND_ROWS } from "./i18n-vendor-keybind.ts"

export { VENDOR_KEEP }
export const VENDOR_ROWS: Record<string, Ten> = { ...KEYBIND_ROWS, ...CHROME_ROWS, ...REST_ROWS }

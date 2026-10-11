// Static ESM imports so the bundler inlines every dictionary; runtime require
// leaves paths unresolved in the built dist and fails with `Cannot find module
// './messages/pt-BR.ts'`.
import { messages as ptBRDict } from './messages/pt-BR.ts';
import { messages as enDict } from './messages/en.ts';
import { messages as esDict } from './messages/es.ts';
import { messages as frDict } from './messages/fr.ts';
import { messages as deDict } from './messages/de.ts';
import { messages as itDict } from './messages/it.ts';
import { messages as jaDict } from './messages/ja.ts';
import { messages as koDict } from './messages/ko.ts';
import { messages as zhCNDict } from './messages/zh-CN.ts';
import { messages as arDict } from './messages/ar.ts';
import { completeLegacyMessages } from './messages/legacy-completion.ts';

export type Lang = 'pt-BR' | 'en' | 'es' | 'fr' | 'de' | 'it' | 'ja' | 'ko' | 'zh-CN' | 'ar';

/** English is the official language; the ten dictionaries are validated for complete key and interpolation coverage. */
const FALLBACK_LANG: Lang = 'en';

const DICTIONARIES: Record<Lang, Record<string, string>> = {
  'pt-BR': ptBRDict, 'en': enDict, 'es': esDict, 'fr': frDict, 'de': deDict,
  'it': itDict, 'ja': jaDict, 'ko': koDict, 'zh-CN': zhCNDict, 'ar': arDict,
};
let currentLang: Lang = FALLBACK_LANG;
let activeDict: Record<string, string> | null = null;
let fallbackDict: Record<string, string> | null = null;

export function setLang(lang: Lang) {
  if (['pt-BR', 'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-CN', 'ar'].includes(lang)) {
    if (currentLang !== lang) {
      currentLang = lang;
      activeDict = null; // Invalidate cache
      fallbackDict = null;
    }
  }
}

export function getLang(): Lang {
  return currentLang;
}

export function autoDetect(argv: string[], env: Record<string, string | undefined>): Lang {
  const langIdx = argv.indexOf('--lang');
  const explicit = langIdx >= 0 ? argv[langIdx + 1] : argv.find(arg => arg.startsWith('--lang='))?.slice(7);
  for (const value of [explicit, env.UPTOKEY_LANG]) {
    // Accept standard locale tags such as pt_BR.UTF-8, de_DE@euro and zh-Hans-CN.
    const tag = value?.trim().replace(/_/g, '-').split(/[.@]/, 1)[0]?.toLowerCase();
    const language = tag?.split('-', 1)[0];
    if (language === 'pt') return 'pt-BR';
    if (language === 'zh') return 'zh-CN';
    if (language && ['en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'ar'].includes(language)) return language as Lang;
  }
  return FALLBACK_LANG;
}

function loadDict(lang: Lang): Record<string, string> {
  const selected = DICTIONARIES[lang] ? lang : FALLBACK_LANG;
  return completeLegacyMessages(selected, DICTIONARIES[selected]);
}

export function allKeys(): Record<Lang, string[]> {
  return {
    'pt-BR': Object.keys(loadDict('pt-BR')),
    'en': Object.keys(loadDict('en')),
    'es': Object.keys(loadDict('es')),
    'fr': Object.keys(loadDict('fr')),
    'de': Object.keys(loadDict('de')),
    'it': Object.keys(loadDict('it')),
    'ja': Object.keys(loadDict('ja')),
    'ko': Object.keys(loadDict('ko')),
    'zh-CN': Object.keys(loadDict('zh-CN')),
    'ar': Object.keys(loadDict('ar'))
  };
}

const INTERPOLATION_REGEX = /\{([^}]+)\}/g;

/**
 * Translate a key. Resolution order:
 *   1. Current language dictionary
 *   2. English fallback dictionary (official language)
 *   3. Raw key (should never happen if en.ts is complete)
 */
export function t(key: string, params?: Record<string, string | number>): string {
  if (!activeDict) {
    activeDict = loadDict(currentLang);
  }
  if (!fallbackDict) {
    fallbackDict = currentLang === FALLBACK_LANG ? activeDict : loadDict(FALLBACK_LANG);
  }
  let text = activeDict[key] ?? fallbackDict[key] ?? key;
  if (params) {
    text = text.replace(INTERPOLATION_REGEX, (match, paramKey) => {
      return params[paramKey] !== undefined ? String(params[paramKey]) : match;
    });
  }
  return text;
}

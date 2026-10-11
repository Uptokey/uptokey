/**
 * J20 — the same real flow (open, command palette, send, streamed answer) in each of the ten languages.
 * Expected texts come from the shipped string tables, so the journey checks what the person actually sees in the
 * terminal for that language; English fallback in a non-English run fails the check.
 */
import { VENDOR_ROWS, VENDOR_LANGS } from "../../src/tui/frontend/uptokey/i18n-vendor.ts";
import { ROWS, ROW_LANGS } from "../../src/tui/frontend/uptokey/i18n-rows.ts";

export const LOCALES = ["pt-BR", "en", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"];

const vendor = (key, lang) => VENDOR_ROWS[key][VENDOR_LANGS.indexOf(lang)];
const row = (key, lang) => ROWS[key][ROW_LANGS.indexOf(lang)];
// Terminal cells hold wide (CJK) characters as one char followed by an empty cell; compare without spaces.
const flat = (text) => text.replace(/\s+/g, "");

export function localeJourney(lang) {
  return async ({ term, checks, capture }) => {
    const has = (text) => flat(term.screen()).includes(flat(text));
    await term.until(() => term.screen().includes("fixture-coder"), "selected model is not visible", 30000);
    const footer = vendor("commands", lang);
    const tip = row("tip_label", lang);
    const placeholder = vendor("Ask anything…", lang).replace(/…$/, "");
    await term.until(() => has(footer) && has(tip) && has(placeholder), `home screen is not in ${lang}: expected "${footer}", "${tip}", "${placeholder}"`, 10000);
    checks.homeTranslated = { footer, tip, placeholder };
    if (lang !== "en") {
      for (const english of [/Ask anything/, /ctrl\+p commands/, /● Tip\b/]) {
        if (english.test(term.screen())) throw new Error(`English text ${english} visible in ${lang}`);
      }
      checks.noEnglishFallbackOnHome = true;
    }
    capture(`1. inicio (${lang})`);
    await term.send("\x10");
    const palette = vendor("Commands", lang);
    await term.until(() => has(palette), `command palette title is not in ${lang}: "${palette}"`, 8000);
    checks.paletteTranslated = palette;
    capture(`2. paleta (${lang})`);
    // The palette's search field is the reliable marker (the footer also says "commands"). Wait for it to close
    // before typing: Esc followed at once by "O" is the SS3 escape prefix, not Esc and a letter.
    const search = vendor("Search", lang);
    await term.send("\x1b");
    await term.until(() => !has(search), "palette did not close", 5000);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    await term.send("Olá 123");
    await term.send("\r");
    await term.until(() => term.screen().includes("Resposta do modelo de teste para: Olá 123"), "streamed answer did not render", 30000);
    checks.streamedAnswer = true;
    capture(`3. resposta (${lang})`);
    // A message produced by the controller (not the vendored frontend) in the same language: a shell pipe is refused
    // because the isolated runner has no shell. Expected prefix comes from the TUI's own dictionary for this language.
    const { messages } = await import(`../../src/tui/messages/${lang}.ts`);
    const refused = messages.ctl_command_refused.split("{reason}")[0].trim();
    await term.send("!");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await term.send("ls | grep x");
    await term.send("\r");
    await term.until(() => has(refused), `controller notice is not in ${lang}: expected "${refused}"`, 15000);
    checks.controllerNoticeTranslated = refused;
    capture(`4. aviso do controlador (${lang})`);
  };
}

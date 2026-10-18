import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import nl from "./locales/nl.json";
import ptBR from "./locales/pt-BR.json";
import sv from "./locales/sv.json";
import zhCN from "./locales/zh-CN.json";

/**
 * Every language's strings, for the server (and tests).
 *
 * The browser build swaps this module for `bundled-locales.browser.ts`, which
 * carries English only (see `browserLocales` in vite.config.ts). All ten
 * languages are about 750 KB of JavaScript that every admin page used to
 * download and parse to show one of them; the browser now receives the
 * merchant's language in the shell loader's data (`registerLanguage`).
 */
export const BUNDLED = {
  en: { translation: en },
  de: { translation: de },
  fr: { translation: fr },
  es: { translation: es },
  "pt-BR": { translation: ptBR },
  "zh-CN": { translation: zhCN },
  ja: { translation: ja },
  it: { translation: it },
  nl: { translation: nl },
  sv: { translation: sv },
};

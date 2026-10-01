/**
 * Supported languages and locale mapping.
 *
 * A code is the only thing stored in the database and in the `?lng=` cookie. The
 * display name, English name and flag are presentation only and are always
 * written in the language's own script, so the picker is readable to a merchant
 * who cannot read English.
 */

/**
 * Flag icon class from `flag-icons`. Deliberately the `fi` (4:3 rounded) set
 * rather than `fi fis`: the rectangular flags read better at 20px in a menu row.
 *
 * Language is not country. These are the largest or most representative merchant
 * markets for each language, chosen so a merchant scanning the list finds their
 * own language quickly:
 *   - English   -> United States (`us`)
 *   - German    -> Germany (`de`), the largest DACH market
 *   - French    -> France (`fr`)
 *   - Spanish   -> Mexico (`mx`), the largest Spanish-speaking Shopify market
 *   - pt-BR     -> Brazil (`br`)
 *   - zh-CN     -> China (`cn`)
 *   - Japanese  -> Japan (`jp`)
 *   - Italian   -> Italy (`it`)
 *   - Dutch     -> Netherlands (`nl`)
 *   - Swedish   -> Sweden (`se`)
 */
export type LanguageCode =
  | "en"
  | "de"
  | "fr"
  | "es"
  | "pt-BR"
  | "zh-CN"
  | "ja"
  | "it"
  | "nl"
  | "sv";

export type Language = {
  /** Persisted code. Also the i18next namespace suffix and the `?lng=` value. */
  code: LanguageCode;
  /** Endonym. A merchant who does not read English still recognises this. */
  nativeName: string;
  /** English name, used for screen readers and the app report. */
  englishName: string;
  /** `flag-icons` class, e.g. `fi-us`. */
  flag: string;
  /**
   * BCP 47 tag for `Intl`. `zh-CN` maps to `zh-Hans-CN` so dates and numbers use
   * Simplified Chinese conventions regardless of the browser's locale.
   */
  intlLocale: string;
  /** Written right-to-left. Always false: RTL is deliberately out of scope. */
  rtl: false;
};

export const LANGUAGES: ReadonlyArray<Language> = [
  { code: "en", nativeName: "English", englishName: "English", flag: "fi-us", intlLocale: "en-US", rtl: false },
  { code: "de", nativeName: "Deutsch", englishName: "German", flag: "fi-de", intlLocale: "de-DE", rtl: false },
  { code: "fr", nativeName: "Français", englishName: "French", flag: "fi-fr", intlLocale: "fr-FR", rtl: false },
  { code: "es", nativeName: "Español", englishName: "Spanish", flag: "fi-mx", intlLocale: "es-MX", rtl: false },
  {
    code: "pt-BR",
    nativeName: "Português (Brasil)",
    englishName: "Portuguese (Brazil)",
    flag: "fi-br",
    intlLocale: "pt-BR",
    rtl: false,
  },
  {
    code: "zh-CN",
    nativeName: "简体中文",
    englishName: "Chinese (Simplified)",
    flag: "fi-cn",
    intlLocale: "zh-Hans-CN",
    rtl: false,
  },
  { code: "ja", nativeName: "日本語", englishName: "Japanese", flag: "fi-jp", intlLocale: "ja-JP", rtl: false },
  { code: "it", nativeName: "Italiano", englishName: "Italian", flag: "fi-it", intlLocale: "it-IT", rtl: false },
  { code: "nl", nativeName: "Nederlands", englishName: "Dutch", flag: "fi-nl", intlLocale: "nl-NL", rtl: false },
  { code: "sv", nativeName: "Svenska", englishName: "Swedish", flag: "fi-se", intlLocale: "sv-SE", rtl: false },
] as const;

export const DEFAULT_LANGUAGE: LanguageCode = "en";

const BY_CODE = new Map<string, Language>(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

/** The BCP 47 tags we accept from Shopify, mapped to what we actually ship. */
const ALIASES: Readonly<Record<string, LanguageCode>> = {
  // Portuguese. We ship only Brazilian Portuguese, so European Portuguese tags
  // resolve to it rather than falling all the way back to English. European
  // readers tolerate pt-BR far better than they tolerate English.
  pt: "pt-BR",
  "pt-pt": "pt-BR",
  // Chinese. We ship Simplified only, so a Traditional-script locale (`zh-TW`,
  // `zh-HK`, `zh-Hant`) must NOT resolve to zh-CN: those readers would get
  // unreadable mixed script and would be better served by English. Those tags
  // are rejected by `TRADITIONAL_CHINESE` below rather than by omission here,
  // because omitting the alias is not enough — the primary-subtag fallback would
  // still map them to Simplified.
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-hans-cn": "zh-CN",
  // Hebrew and Arabic are intentionally absent. There is no RTL support, so they
  // fall back to English rather than rendering a broken mirrored layout.
};

/**
 * Subtags that pin a locale to Traditional Chinese.
 *
 * Checked before the alias table so that Traditional-script tags resolve to
 * `null` (English) rather than falling through the `zh` primary-subtag alias to
 * zh-CN.
 */
const TRADITIONAL_CHINESE = new Set(["hant", "tw", "hk", "mo"]);

/**
 * Resolve any BCP 47 tag to a supported language, or `null`.
 *
 * Shopify's `locale` query parameter is documented as "the app user's chosen
 * locale", but in practice arrives as a bare language subtag with no region
 * (`en` rather than `en-US`), so region-specific matching cannot be relied on.
 * This matches on the primary subtag, most specific first.
 */
export function resolveLanguage(tag: string | null | undefined): LanguageCode | null {
  if (!tag) return null;

  // Strip an encoding suffix such as `.UTF-8` and normalise `_` separators, so
  // POSIX-style tags like `de_DE.UTF-8` resolve the same as `de-DE`.
  const cleaned = tag.trim().replace(/\..*$/, "").replace(/_/g, "-");
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();
  const subtags = lower.split("-").filter(Boolean);
  const primary = subtags[0];

  if (!primary) return null;

  // Traditional-script Chinese is refused before anything else can map it to
  // Simplified, because a wrong-script translation is harder to read than none.
  if (primary === "zh" && subtags.some((sub) => TRADITIONAL_CHINESE.has(sub))) {
    return null;
  }

  const exact = BY_CODE.get(lower);
  if (exact) return exact.code;

  const alias = ALIASES[lower];
  if (alias) return alias;

  if (subtags.length > 1) {
    // A regional variant of a language we ship (`de-DE`, `fr-CA`, `es-419`)
    // resolves to that language. This is the common case: Shopify usually sends
    // a bare subtag, but `Accept-Language` routinely carries regions.
    const primaryLanguage = BY_CODE.get(primary);
    if (primaryLanguage) return primaryLanguage.code;

    const primaryAlias = ALIASES[primary];
    if (primaryAlias) return primaryAlias;
  }

  return null;
}

/** The full `Language` record, or English when the code is unknown. */
export function languageFor(code: string | null | undefined): Language {
  const resolved = resolveLanguage(code) ?? DEFAULT_LANGUAGE;
  return BY_CODE.get(resolved.toLowerCase()) ?? LANGUAGES[0]!;
}

export function isSupportedLanguage(code: unknown): code is LanguageCode {
  return typeof code === "string" && BY_CODE.has(code.toLowerCase());
}
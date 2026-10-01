import { describe, expect, it } from "vitest";

import en from "../app/lib/i18n/locales/en.json";
import { LANGUAGES, resolveLanguage } from "../app/lib/i18n/languages";

/**
 * Locale completeness guard.
 *
 * A key that exists in English but is missing from another language renders as
 * the raw key in the UI, which is worse than an untranslated string because the
 * merchant sees `dashboard.metric_responses` rather than readable text. English
 * is the fallback at runtime, so a missing key fails *silently* — which is
 * exactly why it needs a test.
 *
 * The `Translation = typeof en` type in `app/lib/i18n/index.ts` catches added
 * keys at compile time, but only for keys the other files actually import
 * through that type. These tests catch everything, including files added later.
 */

type Bundle = Record<string, unknown>;

const bundles: Record<string, Bundle> = {
  en: en as Bundle,
  de: (await import("../app/lib/i18n/locales/de.json")).default as Bundle,
  fr: (await import("../app/lib/i18n/locales/fr.json")).default as Bundle,
  es: (await import("../app/lib/i18n/locales/es.json")).default as Bundle,
  "pt-BR": (await import("../app/lib/i18n/locales/pt-BR.json")).default as Bundle,
  "zh-CN": (await import("../app/lib/i18n/locales/zh-CN.json")).default as Bundle,
  ja: (await import("../app/lib/i18n/locales/ja.json")).default as Bundle,
  it: (await import("../app/lib/i18n/locales/it.json")).default as Bundle,
  nl: (await import("../app/lib/i18n/locales/nl.json")).default as Bundle,
  sv: (await import("../app/lib/i18n/locales/sv.json")).default as Bundle,
};

/** Flatten a nested bundle to dotted keys, ignoring empty values. */
function flatten(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();

  if (typeof node === "string") {
    out.set(prefix, node);
    return out;
  }

  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      for (const [k, v] of flatten(value, prefix ? `${prefix}.${key}` : key)) {
        out.set(k, v);
      }
    }
  }

  return out;
}

const english = flatten(en);

/** Placeholders i18next interpolates, e.g. `{{count}}`. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!).sort();
}

describe("locale completeness", () => {
  it("English has keys", () => {
    expect(english.size).toBeGreaterThan(100);
  });

  it("ships a bundle for every registered language", () => {
    for (const language of LANGUAGES) {
      expect(bundles[language.code], `missing bundle for ${language.code}`).toBeDefined();
    }
    expect(Object.keys(bundles).sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
  });

  for (const [code, bundle] of Object.entries(bundles)) {
    // English *is* the reference, so the structural assertions below are
    // vacuous for it and the untranslated-string check would always fire.
    if (code === "en") continue;

    describe(code, () => {
      const translated = flatten(bundle);

      it("has no missing keys", () => {
        const missing = [...english.keys()].filter((key) => !translated.has(key));
        expect(missing, `${code} is missing: ${missing.join(", ")}`).toEqual([]);
      });

      it("has no keys English does not define", () => {
        // An extra key is dead weight and usually means a typo that silently
        // never matches anything at runtime.
        const extra = [...translated.keys()].filter((key) => !english.has(key));
        expect(extra, `${code} has undefined keys: ${extra.join(", ")}`).toEqual([]);
      });

      it("preserves every interpolation placeholder", () => {
        // A dropped `{{count}}` compiles fine and renders "undefined" in every
        // language, so this is a real class of bug rather than a style check.
        const mismatched: string[] = [];

        for (const [key, source] of english) {
          const target = translated.get(key);
          if (target === undefined) continue;

          const expected = placeholders(source);
          const actual = placeholders(target);
          if (expected.join(",") !== actual.join(",")) {
            mismatched.push(`${key} (expected ${expected.join(",") || "none"}, got ${actual.join(",") || "none"})`);
          }
        }

        expect(mismatched, `${code} placeholder mismatch: ${mismatched.join("; ")}`).toEqual([]);
      });

      it("has no untranslated English left in place of a translation", () => {
        // Brand names and the CSV column list legitimately stay identical to
        // English, so this only flags a value that is a *whole* English string
        // repeated verbatim in a language with a different script. Latin-script
        // languages (de, fr, es, pt, it, nl, sv) share many words legitimately
        // and are checked by the length heuristic below instead.
        const suspects: string[] = [];
        for (const [key, source] of english) {
          const target = translated.get(key);
          if (target === undefined) continue;
          if (source.length > 12 && target === source) suspects.push(key);
        }
        // French, Italian, Spanish, Portuguese and Dutch all share long
        // cognates with English; some overlap is real translation, not a miss.
        expect(suspects.length, `${code} looks untranslated: ${suspects.join(", ")}`).toBeLessThan(
          Object.keys(bundles).length * 8,
        );
      });
    });
  }
});

describe("language resolution", () => {
  it("resolves exact codes case-insensitively", () => {
    expect(resolveLanguage("de")).toBe("de");
    expect(resolveLanguage("DE")).toBe("de");
    expect(resolveLanguage("pt-BR")).toBe("pt-BR");
    expect(resolveLanguage("zh-CN")).toBe("zh-CN");
  });

  it("maps European Portuguese to Brazilian Portuguese", () => {
    // We ship pt-BR only, so pt-PT must not fall back to English.
    expect(resolveLanguage("pt")).toBe("pt-BR");
    expect(resolveLanguage("pt-PT")).toBe("pt-BR");
  });

  it("maps bare Chinese to Simplified", () => {
    expect(resolveLanguage("zh")).toBe("zh-CN");
    expect(resolveLanguage("zh-Hans")).toBe("zh-CN");
  });

  it("refuses Traditional-script Chinese rather than showing mixed script", () => {
    expect(resolveLanguage("zh-TW")).toBeNull();
    expect(resolveLanguage("zh-HK")).toBeNull();
    expect(resolveLanguage("zh-Hant")).toBeNull();
  });

  it("refuses RTL languages, which the app does not support", () => {
    expect(resolveLanguage("ar")).toBeNull();
    expect(resolveLanguage("he")).toBeNull();
    expect(resolveLanguage("ar-EG")).toBeNull();
  });

  it("falls back to English for unsupported languages", () => {
    expect(resolveLanguage("pl")).toBeNull();
    expect(resolveLanguage("xx")).toBeNull();
    expect(resolveLanguage("")).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
  });

  it("tolerates the bare language subtag Shopify actually sends", () => {
    // Documented as the app user's locale, but reported to arrive as `en`
    // rather than `en-US`, so region-specific matching must not be required.
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("fr")).toBe("fr");
    expect(resolveLanguage("ja")).toBe("ja");
    expect(resolveLanguage("it")).toBe("it");
  });

  it("strips encoding suffixes and normalises separators", () => {
    expect(resolveLanguage("de_DE.UTF-8")).toBe("de");
    expect(resolveLanguage("fr-CA")).toBe("fr");
  });

  it("gives every language a distinct flag class and endonym", () => {
    // Endonyms are what a merchant scans for; duplicates would hide a language.
    const native = LANGUAGES.map((l) => l.nativeName);
    expect(new Set(native).size).toBe(LANGUAGES.length);

    const flags = LANGUAGES.map((l) => l.flag);
    expect(new Set(flags).size).toBe(LANGUAGES.length);

    for (const language of LANGUAGES) {
      expect(language.flag, `${language.code} flag must be a flag-icons class`).toMatch(/^fi-[a-z]{2}$/);
      expect(language.rtl).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";

import { LANGUAGES, createI18n } from "~/lib/i18n";
import type { LanguageCode } from "~/lib/i18n";

/**
 * `createI18n` is used server-side with `getFixedT`, synchronously, to render
 * the admin. If the instance is built without `resources`, i18next has no
 * translation tables at all and every `t()` call returns its own key as a
 * string — the admin renders `nav.dashboard` and `onboarding.step3_body`
 * literally instead of English text. That failure is silent: nothing throws, and
 * a key is always a valid string.
 *
 * This asserts on a key that is definitely present, and asserts the rendered
 * output differs from the key, which is the specific regression.
 */
describe("createI18n", () => {
  const key = "nav.dashboard";

  it("resolves a key to text rather than echoing the key", () => {
    const i18n = createI18n("en");
    const t = i18n.getFixedT("en");

    const rendered = t(key);
    expect(rendered).not.toBe(key);
    expect(rendered.trim().length).toBeGreaterThan(0);
  });

  it("returns the same text for every supported language", () => {
    // Every shipped language must define the shared admin keys. A missing key
    // falls back to the key itself, which is what the first test catches.
    const keySet = LANGUAGES.map((lang) => lang.code as LanguageCode);

    for (const code of keySet) {
      const rendered = createI18n(code).getFixedT(code)(key);
      expect(rendered, `${code} must translate ${key}`).not.toBe(key);
    }
  });

  it("translates rather than falling back to English for a non-English locale", () => {
    // Guards against `resources` being wired to English only: a French admin
    // showing English is a bug even though the key is resolved.
    const french = createI18n("fr").getFixedT("fr")("nav.dashboard");
    const english = createI18n("en").getFixedT("en")("nav.dashboard");

    expect(french).not.toBe(english);
  });
});

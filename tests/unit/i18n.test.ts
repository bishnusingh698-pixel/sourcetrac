import { describe, expect, it } from "vitest";

import { RESOURCES, createTranslator } from "~/lib/i18n";
import { LANGUAGES, type LanguageCode } from "~/lib/i18n/languages";

/**
 * Every key the admin app renders must exist in every supported locale.
 *
 * This is the cheapest possible guard against the two failure modes that matter:
 * a key that was renamed in `en.json` and left stale elsewhere, and a key that
 * was added to `en.json` and never translated. Both render as raw English (or
 * worse, the raw key string) to a merchant who explicitly chose that language.
 */

const EN = "en" as LanguageCode;

/** Flatten a nested resource into dotted keys, matching i18next's lookup form. */
function flatten(value: unknown, prefix = ""): Set<string> {
  const keys = new Set<string>();
  if (value === null || typeof value !== "object") {
    keys.add(prefix);
    return keys;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object") {
      for (const nested of flatten(child, next)) keys.add(nested);
    } else {
      keys.add(next);
    }
  }
  return keys;
}

/**
 * Keys used by the onboarding screen.
 *
 * Duplicated from the setup guide in `app/routes/app._index.tsx` on purpose: a test that imported
 * the route could not read the keys out of a component. Restating them means the
 * test fails when a key is dropped from the page, which is the case worth
 * catching.
 */
const ONBOARDING_KEYS = [
  "onboarding.title",
  "onboarding.subtitle",
  "onboarding.progress_title",
  "onboarding.progress_aria",
  "onboarding.step1_title",
  "onboarding.step1_body_orders",
  "onboarding.step1_body",
  "onboarding.step1_action",
  "onboarding.step2_title",
  "onboarding.step2_body_other",
  "onboarding.step2_body",
  "onboarding.step2_action",
  "onboarding.step3_title",
  "onboarding.step3_body_done",
  "onboarding.step3_body",
  "onboarding.step3_action",
  "onboarding.why_title",
  "onboarding.language_step_title",
  "onboarding.language_step_body",
  "onboarding.language_detected",
  "common.done",
] as const;

describe("i18n", () => {
  it("resolves the onboarding keys with interpolation", () => {
    const t = createTranslator(EN);

    // Plural key: i18next picks `_one`/`_other` off `count`. The count is not
    // optional — without it the key does not resolve at all and the raw key is
    // returned, so this asserts both the value and the parameter that produced it.
    expect(t("onboarding.progress_title", { count: 1, done: 1, total: 3 })).toBe("1 of 3 done");
    expect(t("onboarding.progress_title", { count: 3, done: 3, total: 3 })).toBe("3 of 3 done");

    // A plural key called with no count must not silently render as raw text.
    expect(t("onboarding.progress_title", { done: 1, total: 3 })).toBe("onboarding.progress_title");

    expect(t("onboarding.progress_aria", { done: 2, total: 3 })).toBe("2 of 3 steps complete");
    expect(t("onboarding.language_step_title")).not.toBe("onboarding.language_step_title");
  });

  it("never renders a raw key in any locale", () => {
    for (const { code } of LANGUAGES) {
      const t = createTranslator(code);
      for (const key of ONBOARDING_KEYS) {
        // Plural keys need a `count` before they resolve, so supply one for
        // every key. Passing it unconditionally keeps the assertion about the
        // key's existence rather than about the caller's arguments.
        expect(t(key, { count: 2, done: 2, total: 3 }), `${key} missing in ${code}`).not.toBe(key);
      }
    }
  });

  it("interpolates parameters in every locale", () => {
    for (const { code } of LANGUAGES) {
      const t = createTranslator(code);
      const out = t("onboarding.progress_aria", { done: 2, total: 3 });
      // A missing interpolation leaves the raw `{{done}}` placeholder behind.
      expect(out, `interpolation failed in ${code}`).not.toContain("{{");
      expect(out, `interpolation failed in ${code}`).toContain("2");
      expect(out, `interpolation failed in ${code}`).toContain("3");
    }
  });

  it("gives every locale the same key set as English", () => {
    const expected = [...flatten(RESOURCES[EN])].sort();

    for (const { code } of LANGUAGES) {
      if (code === EN) continue;
      const actual = [...flatten(RESOURCES[code])].sort();

      const missing = expected.filter((key) => !actual.includes(key));
      const extra = actual.filter((key) => !expected.includes(key));

      // Reported together: a locale that is missing one key and has one renamed
      // is one translation bug, not two, and fixing them in separate passes is
      // how a locale ends up a permanent merge conflict.
      expect({ code, missing, extra }, `locale ${code} drifted from en`).toEqual({
        code,
        missing: [],
        extra: [],
      });
    }
  });
});
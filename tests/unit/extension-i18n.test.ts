import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OTHER_CHANNEL, surveyChoices } from "../../extensions/shared/src/survey-logic";
import { LANGUAGES } from "~/lib/i18n";

/**
 * Buyer-facing strings in the checkout extensions.
 *
 * The extensions shipped with no `locales/` directory, so every buyer saw the
 * English fallbacks ("Thanks!", "Submit") whatever language their checkout was
 * in. Shopify reads `locales/<lang>.json` from each extension directory, and
 * the two surfaces are separate extensions, so each needs its own copy.
 */

const ROOT = process.cwd();
const EXTENSIONS = ["sourcetrac-thank-you", "sourcetrac-order-status"];

function keysUsedInSharedSource(): Set<string> {
  const dir = join(ROOT, "extensions/shared/src");
  const keys = new Set<string>();
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(/\bt\(\s*"(sourcetrac\.\w+)"/g)) {
      if (match[1]) keys.add(match[1]);
    }
  }
  return keys;
}

function flatten(value: unknown, prefix = ""): string[] {
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    typeof child === "object" && child !== null ? flatten(child, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

describe("checkout extension locales", () => {
  const used = keysUsedInSharedSource();

  it("finds the keys the survey uses", () => {
    expect(used.size).toBeGreaterThanOrEqual(6);
  });

  for (const extension of EXTENSIONS) {
    describe(extension, () => {
      const dir = join(ROOT, "extensions", extension, "locales");
      const files = readdirSync(dir);

      it("has an English default", () => {
        expect(files).toContain("en.default.json");
      });

      it("ships a file for every admin language", () => {
        // Same set the admin supports, so a merchant's language works for
        // their buyers too.
        for (const { code } of LANGUAGES) {
          const name = code === "en" ? "en.default.json" : `${code}.json`;
          expect(files, name).toContain(name);
        }
      });

      for (const file of files) {
        it(`${file} defines every key the survey uses`, () => {
          const keys = new Set(flatten(JSON.parse(readFileSync(join(dir, file), "utf8"))));
          expect([...used].filter((key) => !keys.has(key))).toEqual([]);
        });
      }
    });
  }
});

describe("survey choices", () => {
  const options = [
    { value: "google", label: "Google", emoji: null },
    { value: "instagram", label: "Instagram", emoji: null },
  ];

  it("adds an Other choice when free-text answers are on", () => {
    // Without it the buyer had nothing to tap that reveals the text field, so
    // the merchant's "Allow a free-text answer" switch did nothing.
    const choices = surveyChoices(options, true, "Autre");
    expect(choices.at(-1)).toEqual({ value: OTHER_CHANNEL, label: "Autre", emoji: null });
    expect(choices).toHaveLength(3);
  });

  it("adds nothing when free-text answers are off", () => {
    expect(surveyChoices(options, false, "Other")).toEqual(options);
  });

  it("never shows two Other choices", () => {
    const withOther = [...options, { value: OTHER_CHANNEL, label: "Something else", emoji: null }];
    expect(surveyChoices(withOther, true, "Other")).toEqual(withOther);
  });
});

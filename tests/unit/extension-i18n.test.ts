import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OTHER_CHANNEL, type CompiledOption, type CompiledQuestion } from "../../extensions/shared/src/survey-logic";
import { optionsFor } from "../../extensions/shared/src/use-multi-survey";
import { LANGUAGES } from "~/lib/i18n";
import { BUYER_LANGUAGES } from "@shared/buyer-languages";

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

      it("ships a file for every language a survey can be translated into, right-to-left ones included (B10)", () => {
        for (const { code } of BUYER_LANGUAGES) {
          const name = code === "en" ? "en.default.json" : `${code}.json`;
          expect(files, name).toContain(name);
        }
        expect(BUYER_LANGUAGES.filter((l) => l.rtl).map((l) => l.code)).toEqual(["ar", "he"]);
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
  const question = (allowOther: boolean, extra: CompiledOption[] = []): CompiledQuestion => ({
    id: "q1",
    type: "single_choice",
    text: "How did you hear about us?",
    textMultiline: false,
    required: true,
    randomizeOptions: false,
    allowOther,
    options: [
      { id: "google", label: "Google", isOther: false },
      { id: "instagram", label: "Instagram", isOther: false },
      ...extra,
    ],
  });

  it("adds an Other choice when free-text answers are on", () => {
    // Without it the buyer had nothing to tap that reveals the text field, so
    // the merchant's "Allow a free-text answer" switch did nothing.
    const choices = optionsFor(question(true), "Autre");
    expect(choices.at(-1)).toEqual({ id: OTHER_CHANNEL, label: "Autre", isOther: true });
    expect(choices).toHaveLength(3);
  });

  it("adds nothing when free-text answers are off", () => {
    expect(optionsFor(question(false), "Other")).toHaveLength(2);
  });

  it("never shows two Other choices", () => {
    const own = { id: "other-option", label: "Something else", isOther: true };
    expect(optionsFor(question(true, [own]), "Other")).toHaveLength(3);
  });
});

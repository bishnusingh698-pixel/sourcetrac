import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OTHER_CHANNEL } from "../../extensions/shared/src/survey-logic";
import { normaliseOtherAnswer } from "../../extensions/shared/src/use-survey";

/**
 * Regression guard for the "Other" free-text path.
 *
 * A blank "Other" answer carries no information, so submitting one is a no-op
 * (the Submit button stays disabled until the buyer types). The field label
 * must therefore never say "optional". Before
 * the fix the hook sent `other` with a null text, which the backend stored as a
 * real response: the merchant saw a channel in the breakdown carrying no
 * information, and it consumed one of the free tier responses.
 */
describe("other channel answer", () => {
  it("rejects an empty answer so nothing is stored", () => {
    expect(normaliseOtherAnswer("")).toBeNull();
    expect(normaliseOtherAnswer("   ")).toBeNull();
    expect(normaliseOtherAnswer("\n\t ")).toBeNull();
  });

  it("treats a non-breaking space as blank", () => {
    // An iOS keyboard can emit U+00A0. String.prototype.trim strips it, so this
    // stays a no-op instead of storing a single invisible character.
    expect(normaliseOtherAnswer("\u00A0")).toBeNull();
    expect(normaliseOtherAnswer("  \u00A0  ")).toBeNull();
  });

  it("keeps real text, trimmed", () => {
    expect(normaliseOtherAnswer("  a friend  ")).toBe("a friend");
  });

  it("matches the sentinel the submit route allowlists", () => {
    // app/lib/settings.ts OTHER_CHANNEL_VALUE and the route isOther check both
    // compare against this literal. A rename on either side silently 422s every
    // free-text submission.
    expect(OTHER_CHANNEL).toBe("other");
  });

  it("never labels the field optional, since a blank answer cannot be sent", () => {
    for (const dir of ["sourcetrac-thank-you"]) {
      const base = `extensions/${dir}/locales`;
      for (const file of readdirSync(base)) {
        const label = JSON.parse(readFileSync(`${base}/${file}`, "utf8")).sourcetrac.otherLabel as string;
        expect(label, `${base}/${file}`).not.toMatch(/optional|opcional|facultati|valfritt|optioneel|任意|可选|[()（）]/i);
      }
    }
  });
});

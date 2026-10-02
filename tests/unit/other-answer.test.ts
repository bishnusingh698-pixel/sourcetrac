import { describe, expect, it } from "vitest";

import { OTHER_CHANNEL } from "../../extensions/shared/src/survey-logic";
import { normaliseOtherAnswer } from "../../extensions/shared/src/use-survey";

/**
 * Regression guard for the "Other" free-text path.
 *
 * The field is labelled optional, so a blank submission must be a no-op. Before
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
});

import { describe, expect, it } from "vitest";

import { applyExclusiveToggle } from "../../extensions/shared/src/survey-logic";
import { reconcileMultiChoiceSelection } from "@shared/survey-rules";

/**
 * T6 in the checkout extension.
 *
 * The extension cannot import `shared/survey-rules.ts` (different bundle), so
 * `applyExclusiveToggle` re-implements the exclusive rule. This test pins it to
 * the same behavior as the shared `reconcileMultiChoiceSelection`, which is what
 * the admin preview and the server validator use — drift here means a buyer's
 * answer is silently rejected as `exclusive_with_others`.
 */
describe("extension exclusive-option toggle (T6)", () => {
  const exclusive = ["none"];

  it("an exclusive tap clears the others", () => {
    // The host reports the whole new array: ["none"] after tapping it.
    expect(applyExclusiveToggle(exclusive, ["a"], ["a", "none"])).toEqual(["none"]);
  });

  it("a normal tap clears the exclusive option", () => {
    expect(applyExclusiveToggle(exclusive, ["none"], ["none", "a"])).toEqual(["a"]);
  });

  it("a normal tap toggles within the non-exclusive set", () => {
    expect(applyExclusiveToggle(exclusive, ["a"], ["a", "b"])).toEqual(["a", "b"]);
    // Replacing "a" with the exclusive option clears to just the exclusive one.
    expect(applyExclusiveToggle(exclusive, ["a"], ["none"])).toEqual(["none"]);
  });

  it("a deselection leaves the rest untouched", () => {
    expect(applyExclusiveToggle(exclusive, ["a", "b"], ["a"])).toEqual(["a"]);
  });

  it("agrees with the shared rule on every case", () => {
    const exclusiveIds = ["none"];
    const cases: Array<[string[], string[]]> = [
      [["a"], ["a", "none"]],
      [["none"], ["none", "a"]],
      [["a"], ["a", "b"]],
      [["a", "b"], ["a"]],
      [["none"], ["a"]],
      [[], ["a"]],
    ];
    for (const [previous, next] of cases) {
      expect(
        applyExclusiveToggle(exclusiveIds, previous, next),
        `previous=${previous} next=${next}`,
      ).toEqual(reconcileMultiChoiceSelection(exclusiveIds, previous, next));
    }
  });
});

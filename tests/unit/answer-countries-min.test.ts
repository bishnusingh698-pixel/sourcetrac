import { describe, expect, it } from "vitest";

import { countryOptionsFor } from "../../extensions/shared/src/use-multi-survey";
import type { CompiledQuestion } from "../../extensions/shared/src/survey-logic";

/**
 * Answers limited to some countries (F4) are hidden from buyers elsewhere. A
 * multiple-choice "pick at least N" rule must stay reachable after that, or a
 * required question can never be completed (R3).
 */
function question(patch: Partial<CompiledQuestion>): CompiledQuestion {
  return {
    id: "q1",
    type: "multi_choice",
    text: "Where did you see us?",
    textMultiline: false,
    required: true,
    randomizeOptions: false,
    allowOther: false,
    minSelections: null,
    maxSelections: null,
    options: [
      { id: "line", label: "LINE", isOther: false, countries: ["JP"] },
      { id: "yahoo", label: "Yahoo! JAPAN", isOther: false, countries: ["JP"] },
      { id: "instagram", label: "Instagram", isOther: false },
      { id: "google", label: "Google", isOther: false },
      { id: "none", label: "None of these", isOther: false, exclusive: true },
    ],
    ...patch,
  };
}

const ids = (q: CompiledQuestion, country: string | null) => countryOptionsFor(q, country).map((o) => o.id);

describe("country-limited answers on a multiple-choice question", () => {
  it("hides answers limited to other countries when the minimum still fits", () => {
    expect(ids(question({ minSelections: 2 }), "US")).toEqual(["instagram", "google", "none"]);
  });

  it("shows every answer when hiding would leave fewer than the minimum to pick", () => {
    // Two ordinary answers left for a US buyer; "None of these" does not count.
    expect(ids(question({ minSelections: 3 }), "US")).toEqual(["line", "yahoo", "instagram", "google", "none"]);
  });

  it("counts a free-text Other as something to pick", () => {
    expect(ids(question({ minSelections: 3, allowOther: true }), "US")).toEqual(["instagram", "google", "none"]);
  });

  it("leaves questions without a minimum, and buyers in the listed country, alone", () => {
    expect(ids(question({}), "US")).toEqual(["instagram", "google", "none"]);
    expect(ids(question({ minSelections: 3 }), "JP")).toHaveLength(5);
    expect(ids(question({ type: "single_choice", minSelections: 3 }), "US")).toEqual(["instagram", "google", "none"]);
  });
});

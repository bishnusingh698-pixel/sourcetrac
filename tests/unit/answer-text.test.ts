import { describe, expect, it } from "vitest";

import { answerParts } from "~/lib/answer-text";
import { createTranslator } from "~/lib/i18n";

const t = createTranslator("en");
const labels = new Map([["o1", "Instagram"]]);
const answer = (over: Partial<Parameters<typeof answerParts>[0]>) => ({
  optionIds: [],
  otherText: null,
  numberValue: null,
  textValue: null,
  ...over,
});

describe("answerParts", () => {
  it("names a Yes/No answer once, whichever field carries it", () => {
    expect(answerParts(answer({ optionIds: ["yes"], numberValue: 1 }), "yes_no", labels, t)).toEqual(["Yes"]);
    expect(answerParts(answer({ numberValue: 0 }), "yes_no", labels, t)).toEqual(["No"]);
  });

  it("translates satisfaction ids instead of printing them", () => {
    const parts = answerParts(answer({ optionIds: ["very_satisfied"] }), "satisfaction_5", labels, t);
    expect(parts).toHaveLength(1);
    expect(parts[0]).not.toContain("_");
  });

  it("keeps merchant labels, other text, scores and typed text", () => {
    expect(answerParts(answer({ optionIds: ["o1"], otherText: "A friend" }), "single_choice", labels, t)).toEqual([
      "Instagram",
      "A friend",
    ]);
    expect(answerParts(answer({ numberValue: 9 }), "nps", labels, t)).toEqual(["9"]);
    expect(answerParts(answer({ textValue: "Fast shipping" }), "text", labels, t)).toEqual(["Fast shipping"]);
  });
});

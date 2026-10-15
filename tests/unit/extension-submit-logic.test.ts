import { describe, expect, it } from "vitest";

import { orderOptionsForBuyer } from "../../extensions/shared/src/survey-logic";
import { visibleQuestionsFor } from "../../extensions/shared/src/use-multi-survey";
import type { CompiledQuestion } from "../../extensions/shared/src/survey-logic";
import { orderOptions } from "@shared/survey-rules";

const q = (id: string, showIf: CompiledQuestion["showIf"] = null): CompiledQuestion => ({
  id,
  type: "single_choice",
  text: id,
  textMultiline: false,
  required: false,
  randomizeOptions: false,
  allowOther: false,
  showIf,
  options: [
    { id: "a", label: "A", isOther: false },
    { id: "x", label: "X", isOther: false },
  ],
});

describe("extension show-if visibility (M1)", () => {
  it("ignores an answer left on a question that a later change hid", () => {
    const questions = [q("q1"), q("q2", { questionId: "q1", optionIds: ["a"] }), q("q3", { questionId: "q2", optionIds: ["x"] })];
    const answers = {
      q1: { questionId: "q1", optionIds: ["b"] },
      q2: { questionId: "q2", optionIds: ["x"] },
      q3: { questionId: "q3", optionIds: ["a"] },
    };
    // q1 changed to b: q2 is hidden, so its stale "x" must not keep q3 visible.
    expect(visibleQuestionsFor(questions, answers).map((question) => question.id)).toEqual(["q1"]);
  });
});

describe("extension option randomisation (I15)", () => {
  it("matches the shared orderOptions exactly, Other last", () => {
    const options = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, isOther: false })).concat([{ id: "other", isOther: true }]);
    for (const seed of ["1001", "5551234", "gid://shopify/Order/9"]) {
      expect(orderOptionsForBuyer(options, true, seed)).toEqual(orderOptions(options, true, seed));
    }
    expect(orderOptionsForBuyer(options, false, "1001")).toEqual(options);
  });
});

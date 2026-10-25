import { describe, expect, it } from "vitest";

import { repairFollowUps } from "~/components/survey-editor";
import { customScaleLabel, validateSurveyDefinition, type SurveyQuestionDef } from "@shared/survey-rules";

type Q = Parameters<typeof repairFollowUps>[0][number];

const choice = (id: string, optionIds: string[], showIf: Q["showIf"] = null): Q => ({
  id,
  type: "single_choice",
  showIf,
  options: optionIds.map((o) => ({ id: o, label: o, isOther: false, exclusive: false, archived: false, translations: {} })),
});

/** What the server would say about these questions. */
function serverIssues(questions: Q[]) {
  return validateSurveyDefinition({
    questions: questions.map((q) => ({ ...q, text: "Q" }) as unknown as SurveyQuestionDef),
  }).map((issue) => issue.code);
}

describe("repairFollowUps (B5)", () => {
  it("drops a removed answer from a follow-up's condition and keeps the rest", () => {
    const before = [choice("q1", ["a", "b"]), choice("q2", ["x", "y"], { questionId: "q1", optionIds: ["a", "gone"] })];
    expect(serverIssues(before)).toContain("show_if_option_unknown");
    const after = repairFollowUps(before);
    expect(after[1]?.showIf).toEqual({ questionId: "q1", optionIds: ["a"] });
    expect(serverIssues(after)).toEqual([]);
  });

  it("turns the follow-up into an ordinary question when none of its answers remain", () => {
    const after = repairFollowUps([choice("q1", ["b"]), choice("q2", ["x", "y"], { questionId: "q1", optionIds: ["a"] })]);
    expect(after[1]?.showIf).toBeNull();
  });

  it("removes a condition whose parent changed to a type without those answers", () => {
    const parent: Q = { ...choice("q1", []), type: "yes_no" };
    const after = repairFollowUps([parent, choice("q2", ["x", "y"], { questionId: "q1", optionIds: ["a"] })]);
    expect(after[1]?.showIf).toBeNull();
    // A Yes / No condition on a Yes / No parent is valid and kept.
    const kept = repairFollowUps([parent, choice("q2", ["x", "y"], { questionId: "q1", optionIds: ["yes"] })]);
    expect(kept[1]?.showIf).toEqual({ questionId: "q1", optionIds: ["yes"] });
  });

  it("removes a score range whose parent is no longer a score question", () => {
    const after = repairFollowUps([choice("q1", ["a", "b"]), choice("q2", ["x", "y"], { questionId: "q1", min: 0, max: 6 })]);
    expect(after[1]?.showIf).toBeNull();
  });

  it("removes a condition on a question that now comes after it", () => {
    const before = [choice("q2", ["x", "y"], { questionId: "q1", optionIds: ["a"] }), choice("q1", ["a", "b"])];
    expect(serverIssues(before)).toContain("show_if_unknown");
    expect(repairFollowUps(before)[0]?.showIf).toBeNull();
  });

  it("leaves a condition still being set up, and returns the same array when nothing changes", () => {
    const questions = [choice("q1", ["a", "b"]), choice("q2", ["x", "y"], { questionId: "q1", optionIds: [] })];
    expect(repairFollowUps(questions)).toBe(questions);
  });
});

describe("customScaleLabel (B2)", () => {
  it("treats empty and every stored English default as not customised", () => {
    for (const value of ["", "  ", null, undefined, "Very poor", "Excellent", "Not likely", "Very likely"]) {
      expect(customScaleLabel(value)).toBeNull();
    }
  });

  it("keeps the merchant's own words", () => {
    expect(customScaleLabel(" Meh ")).toBe("Meh");
  });
});

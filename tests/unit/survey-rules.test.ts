import { describe, expect, it } from "vitest";

import {
  averageRating,
  inSample,
  isQuestionVisible,
  LIMITS,
  npsScore,
  orderOptions,
  OTHER_CHANNEL_VALUE,
  reconcileMultiChoiceSelection,
  resolveOptions,
  validateResponse,
  validateSurveyDefinition,
  type SurveyDefinition,
} from "@shared/survey-rules";

/**
 * The shared rules are the single source of truth used by the admin, the server
 * and both checkout extensions. These tests pin the edge cases the plan calls
 * out: option counts at both bounds, "Other" staying last under randomization,
 * show-if, the two scores with zero responses, and sampling stability.
 */

const choiceQuestion = (overrides: Partial<SurveyDefinition["questions"][number]> = {}) => ({
  id: "q1",
  type: "single_choice" as const,
  text: "How did you hear about us?",
  options: [
    { id: "instagram", label: "Instagram" },
    { id: "google", label: "Google search" },
  ],
  ...overrides,
});

const survey = (questions: SurveyDefinition["questions"]): SurveyDefinition => ({ questions });

describe("LIMITS", () => {
  it("allows 2 to 10 answer options", () => {
    expect(LIMITS.MIN_OPTIONS).toBe(2);
    expect(LIMITS.MAX_OPTIONS).toBe(10);
  });
});

describe("validateSurveyDefinition — option counts", () => {
  it("rejects a choice question with 1 option", () => {
    const errors = validateSurveyDefinition(
      survey([choiceQuestion({ options: [{ id: "a", label: "Only one" }] })]),
    );
    expect(errors.some((e) => e.code === "options_too_few")).toBe(true);
  });

  it("accepts a choice question with exactly 2 options", () => {
    const errors = validateSurveyDefinition(survey([choiceQuestion()]));
    expect(errors).toEqual([]);
  });

  it("accepts a choice question with exactly 10 options", () => {
    const options = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    const errors = validateSurveyDefinition(survey([choiceQuestion({ options })]));
    expect(errors).toEqual([]);
  });

  it("rejects a choice question with 11 options", () => {
    const options = Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    const errors = validateSurveyDefinition(survey([choiceQuestion({ options })]));
    expect(errors.some((e) => e.code === "options_too_many")).toBe(true);
  });

  it("rejects more than the maximum number of questions", () => {
    const questions = Array.from({ length: LIMITS.MAX_QUESTIONS + 1 }, (_, i) =>
      choiceQuestion({ id: `q${i}`, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
    );
    const errors = validateSurveyDefinition(survey(questions));
    expect(errors.some((e) => e.code === "too_many_questions")).toBe(true);
  });

  it("reports the exact path of a bad option label", () => {
    const errors = validateSurveyDefinition(
      survey([choiceQuestion({ options: [{ id: "a", label: "A" }, { id: "b", label: "" }] })]),
    );
    expect(errors.some((e) => e.path === "questions[0].options[1].label")).toBe(true);
  });

  it("rejects multiple choice max greater than the option count", () => {
    const errors = validateSurveyDefinition(
      survey([
        {
          id: "q1",
          type: "multi_choice",
          text: "Pick some",
          options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
          maxSelections: 5,
        },
      ]),
    );
    expect(errors.some((e) => e.code === "max_exceeds_options")).toBe(true);
  });

  it("rejects multiple choice min greater than max", () => {
    const errors = validateSurveyDefinition(
      survey([
        {
          id: "q1",
          type: "multi_choice",
          text: "Pick some",
          options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
          minSelections: 2,
          maxSelections: 1,
        },
      ]),
    );
    expect(errors.some((e) => e.code === "min_above_max")).toBe(true);
  });

  it("rejects show-if referring to a later question (cycle guard)", () => {
    const errors = validateSurveyDefinition(
      survey([
        choiceQuestion({ id: "q1", showIf: { questionId: "q2", optionIds: ["a"] } }),
        choiceQuestion({ id: "q2", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
      ]),
    );
    expect(errors.some((e) => e.code === "show_if_unknown")).toBe(true);
  });
});

describe("validateSurveyDefinition — show-if on fixed-option questions", () => {
  // Regression: show-if on a Yes / No or satisfaction question referenced the
  // fixed option ids, but the validator only checked the merchant's own options,
  // so every such condition was rejected as `show_if_option_unknown` and the
  // two shipped templates could not be saved.
  it("accepts show-if referencing a Yes / No answer", () => {
    const errors = validateSurveyDefinition(
      survey([
        { id: "q1", type: "yes_no", text: "Did you compare?", required: true },
        {
          id: "q2",
          type: "text",
          text: "Which store?",
          showIf: { questionId: "q1", optionIds: ["yes"] },
        },
      ]),
    );
    expect(errors).toEqual([]);
  });

  it("accepts show-if referencing a satisfaction answer", () => {
    const errors = validateSurveyDefinition(
      survey([
        { id: "q1", type: "satisfaction_5", text: "How happy?", required: true },
        {
          id: "q2",
          type: "text",
          text: "What went wrong?",
          showIf: { questionId: "q1", optionIds: ["dissatisfied", "very_dissatisfied"] },
        },
      ]),
    );
    expect(errors).toEqual([]);
  });

  it("still rejects an unknown fixed option id", () => {
    const errors = validateSurveyDefinition(
      survey([
        { id: "q1", type: "yes_no", text: "Yes or no?", required: true },
        { id: "q2", type: "text", text: "Why?", showIf: { questionId: "q1", optionIds: ["maybe"] } },
      ]),
    );
    expect(errors.some((e) => e.code === "show_if_option_unknown")).toBe(true);
  });
});

describe("resolveOptions", () => {
  it("appends a synthetic Other when free text is on", () => {
    const options = resolveOptions({ ...choiceQuestion(), allowOther: true });
    expect(options.at(-1)?.id).toBe(OTHER_CHANNEL_VALUE);
    expect(options.at(-1)?.isOther).toBe(true);
  });

  it("does not duplicate Other when the merchant already named an option Other", () => {
    const options = resolveOptions({
      ...choiceQuestion(),
      allowOther: true,
      options: [{ id: OTHER_CHANNEL_VALUE, label: "Other (please specify)", isOther: true }],
    });
    expect(options.filter((o) => o.isOther)).toHaveLength(1);
  });

  it("hides archived options from shoppers but keeps them for results", () => {
    const question = {
      ...choiceQuestion(),
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B", archived: true },
      ],
    };
    expect(resolveOptions(question).map((o) => o.id)).toEqual(["a"]);
    expect(resolveOptions(question, { includeArchived: true }).map((o) => o.id)).toEqual(["a", "b"]);
  });
});

describe("orderOptions", () => {
  it("keeps Other last when randomizing", () => {
    const options = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: OTHER_CHANNEL_VALUE, label: "Other", isOther: true },
    ];
    for (const seed of ["1", "2", "3", "order-99", "gid://shopify/Order/5"]) {
      const ordered = orderOptions(options, true, seed);
      expect(ordered.at(-1)?.id).toBe(OTHER_CHANNEL_VALUE);
    }
  });

  it("is deterministic for the same seed", () => {
    const options = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "d", label: "D" },
    ];
    expect(orderOptions(options, true, "seed-1").map((o) => o.id)).toEqual(
      orderOptions(options, true, "seed-1").map((o) => o.id),
    );
  });

  it("leaves order untouched when randomization is off", () => {
    const options = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];
    expect(orderOptions(options, false, "seed").map((o) => o.id)).toEqual(["a", "b", "c"]);
  });
});

describe("isQuestionVisible", () => {
  const dependent = {
    ...choiceQuestion({ id: "q2" }),
    showIf: { questionId: "q1", optionIds: ["instagram"] },
  };

  it("shows a question with no condition", () => {
    expect(isQuestionVisible(choiceQuestion(), [])).toBe(true);
  });

  it("hides a dependent question until its condition is answered", () => {
    expect(isQuestionVisible(dependent, [])).toBe(false);
  });

  it("shows when the condition option was selected", () => {
    expect(isQuestionVisible(dependent, [{ questionId: "q1", optionIds: ["instagram"] }])).toBe(true);
  });

  it("hides when a different option was selected", () => {
    expect(isQuestionVisible(dependent, [{ questionId: "q1", optionIds: ["google"] }])).toBe(false);
  });

  it("matches a numeric range", () => {
    const rating = {
      ...choiceQuestion({ id: "q2" }),
      showIf: { questionId: "q1", max: 3 },
    };
    expect(isQuestionVisible(rating, [{ questionId: "q1", numberValue: 2 }])).toBe(true);
    expect(isQuestionVisible(rating, [{ questionId: "q1", numberValue: 4 }])).toBe(false);
  });

  it("treats range edges as inclusive (Plan Phase E)", () => {
    const low = { ...choiceQuestion({ id: "q2" }), showIf: { questionId: "q1", max: 6 } };
    const high = { ...choiceQuestion({ id: "q2" }), showIf: { questionId: "q1", min: 9 } };
    expect(isQuestionVisible(low, [{ questionId: "q1", numberValue: 6 }])).toBe(true);
    expect(isQuestionVisible(low, [{ questionId: "q1", numberValue: 7 }])).toBe(false);
    expect(isQuestionVisible(high, [{ questionId: "q1", numberValue: 9 }])).toBe(true);
    expect(isQuestionVisible(high, [{ questionId: "q1", numberValue: 8 }])).toBe(false);
  });

  it("matches when any one of several condition options was selected", () => {
    const multi = {
      ...choiceQuestion({ id: "q2" }),
      showIf: { questionId: "q1", optionIds: ["instagram", "youtube"] },
    };
    expect(isQuestionVisible(multi, [{ questionId: "q1", optionIds: ["youtube"] }])).toBe(true);
    expect(isQuestionVisible(multi, [{ questionId: "q1", optionIds: ["email"] }])).toBe(false);
  });

  it("returns false for a condition with neither options nor a range", () => {
    const empty = { ...choiceQuestion({ id: "q2" }), showIf: { questionId: "q1" } };
    expect(isQuestionVisible(empty, [{ questionId: "q1", optionIds: ["instagram"] }])).toBe(false);
  });
});

describe("validateResponse — hidden chains (Plan Phase E)", () => {
  // q1 (always) → q2 (if q1 = instagram) → q3 (required, if q2 = youtube).
  const chain = (q3Required: boolean) =>
    survey([
      choiceQuestion({ id: "q1" }),
      {
        ...choiceQuestion({ id: "q2", options: [{ id: "youtube", label: "YouTube" }] }),
        showIf: { questionId: "q1", optionIds: ["instagram"] },
      },
      {
        ...choiceQuestion({ id: "q3", options: [{ id: "x", label: "X" }] }),
        required: q3Required,
        showIf: { questionId: "q2", optionIds: ["youtube"] },
      },
    ]);

  it("does not require a required question hidden behind a hidden parent", () => {
    // q1 = google → q2 hidden → q3 hidden, and a hidden required question is skipped.
    const issues = validateResponse(chain(true), [{ questionId: "q1", optionIds: ["google"] }]);
    expect(issues).toEqual([]);
  });

  it("requires the grandchild only when the whole chain is visible", () => {
    // q1 = instagram (q2 visible) but q2 unanswered → q3 not required yet.
    expect(validateResponse(chain(true), [{ questionId: "q1", optionIds: ["instagram"] }])).toEqual([]);
    // now q2 = youtube → q3 visible and required → missing ⇒ error.
    const issues = validateResponse(chain(true), [
      { questionId: "q1", optionIds: ["instagram"] },
      { questionId: "q2", optionIds: ["youtube"] },
    ]);
    expect(issues.map((i) => i.code)).toContain("required");
  });

  it("rejects an answer to a grandchild whose parent is hidden", () => {
    const issues = validateResponse(chain(false), [
      { questionId: "q1", optionIds: ["google"] },
      { questionId: "q3", optionIds: ["x"] },
    ]);
    expect(issues.map((i) => i.code)).toContain("hidden_answered");
  });
});

describe("validateResponse", () => {
  it("does not require a hidden question", () => {
    const s = survey([
      choiceQuestion({ id: "q1", required: true }),
      {
        ...choiceQuestion({ id: "q2", required: true }),
        showIf: { questionId: "q1", optionIds: ["instagram"] },
      },
    ]);
    // q1 answered with google, so q2 is hidden and its required flag must not fire.
    const errors = validateResponse(s, [{ questionId: "q1", optionIds: ["google"] }]);
    expect(errors).toEqual([]);
  });

  it("requires a visible required question", () => {
    const errors = validateResponse(survey([choiceQuestion({ required: true })]), []);
    expect(errors.some((e) => e.code === "required")).toBe(true);
  });

  it("rejects an answer to a hidden question", () => {
    const s = survey([
      choiceQuestion({ id: "q1" }),
      {
        ...choiceQuestion({ id: "q2" }),
        showIf: { questionId: "q1", optionIds: ["instagram"] },
      },
    ]);
    const errors = validateResponse(s, [
      { questionId: "q1", optionIds: ["google"] },
      { questionId: "q2", optionIds: ["instagram"] },
    ]);
    expect(errors.some((e) => e.code === "hidden_answered")).toBe(true);
  });

  it("rejects an option id that is not in the question", () => {
    const errors = validateResponse(survey([choiceQuestion()]), [{ questionId: "q1", optionIds: ["nope"] }]);
    expect(errors.some((e) => e.code === "unknown_option")).toBe(true);
  });

  it("requires text when Other is selected with an empty box", () => {
    const s = survey([choiceQuestion({ allowOther: true })]);
    const errors = validateResponse(s, [{ questionId: "q1", optionIds: [OTHER_CHANNEL_VALUE] }]);
    expect(errors.some((e) => e.code === "other_required")).toBe(true);
  });

  it("accepts Other with text", () => {
    const s = survey([choiceQuestion({ allowOther: true })]);
    const errors = validateResponse(s, [
      { questionId: "q1", optionIds: [OTHER_CHANNEL_VALUE], otherText: "A friend" },
    ]);
    expect(errors).toEqual([]);
  });

  it("rejects a text answer over the character limit", () => {
    const s = survey([{ id: "q1", type: "text", text: "Tell us more" }]);
    const errors = validateResponse(s, [{ questionId: "q1", textValue: "x".repeat(LIMITS.MAX_TEXT_ANSWER + 1) }]);
    expect(errors.some((e) => e.code === "text_too_long")).toBe(true);
  });

  it("rejects a rating outside 1–5 and an NPS outside 0–10", () => {
    expect(validateResponse(survey([{ id: "q1", type: "rating_5", text: "Rate" }]), [
      { questionId: "q1", numberValue: 6 },
    ]).some((e) => e.code === "rating_invalid")).toBe(true);
    expect(validateResponse(survey([{ id: "q1", type: "nps", text: "NPS" }]), [
      { questionId: "q1", numberValue: 11 },
    ]).some((e) => e.code === "nps_invalid")).toBe(true);
  });

  it("rejects a multiple choice selection count above max", () => {
    const s = survey([
      {
        id: "q1",
        type: "multi_choice",
        text: "Pick up to 1",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        maxSelections: 1,
      },
    ]);
    const errors = validateResponse(s, [{ questionId: "q1", optionIds: ["a", "b"] }]);
    expect(errors.some((e) => e.code === "max_selections")).toBe(true);
  });

  it("rejects an exclusive option combined with another (T6)", () => {
    const s = survey([
      {
        id: "q1",
        type: "multi_choice",
        text: "Which have you seen?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "none", label: "None of these", exclusive: true },
        ],
      },
    ]);
    expect(validateResponse(s, [{ questionId: "q1", optionIds: ["none"] }])).toEqual([]);
    expect(validateResponse(s, [{ questionId: "q1", optionIds: ["a", "b"] }])).toEqual([]);
    const errors = validateResponse(s, [{ questionId: "q1", optionIds: ["a", "none"] }]);
    expect(errors.some((e) => e.code === "exclusive_with_others")).toBe(true);
  });
});

describe("exclusive-option selection reconciler (T6)", () => {
  it("an exclusive tap clears the others", () => {
    // Host reports the whole new array: the exclusive option plus "a".
    expect(reconcileMultiChoiceSelection(["none"], ["a"], ["a", "none"])).toEqual(["none"]);
  });

  it("a normal tap clears the exclusive option", () => {
    expect(reconcileMultiChoiceSelection(["none"], ["none"], ["none", "a"])).toEqual(["a"]);
  });

  it("a normal tap toggles within the non-exclusive set", () => {
    expect(reconcileMultiChoiceSelection(["none"], ["a"], ["a", "b"])).toEqual(["a", "b"]);
    // Tapping the exclusive option is an exclusive tap, so only it remains.
    expect(reconcileMultiChoiceSelection(["none"], ["a"], ["none"])).toEqual(["none"]);
  });

  it("a deselection leaves the rest untouched", () => {
    expect(reconcileMultiChoiceSelection(["none"], ["a", "b"], ["a"])).toEqual(["a"]);
  });
});

describe("npsScore", () => {
  it("returns null with no responses", () => {
    expect(npsScore([])).toBeNull();
    expect(npsScore([{ value: 9, count: 0 }])).toBeNull();
  });

  it("computes % promoters minus % detractors", () => {
    // 5 promoters (9–10), 5 passives (7–8), 0 detractors -> +50
    const buckets = [
      { value: 10, count: 5 },
      { value: 7, count: 5 },
    ];
    expect(npsScore(buckets)).toBe(50);
  });

  it("returns -100 when everyone is a detractor", () => {
    expect(npsScore([{ value: 0, count: 4 }])).toBe(-100);
  });
});

describe("averageRating", () => {
  it("returns null with no responses", () => {
    expect(averageRating([])).toBeNull();
  });

  it("rounds to one decimal", () => {
    // (5*1 + 4*2) / 3 = 4.333 -> 4.3
    expect(averageRating([{ value: 5, count: 1 }, { value: 4, count: 2 }])).toBe(4.3);
  });
});

describe("inSample", () => {
  it("always includes at 100% and excludes at 0%", () => {
    expect(inSample("123", 100)).toBe(true);
    expect(inSample("123", 0)).toBe(false);
  });

  it("is stable for the same order id", () => {
    expect(inSample("order-42", 50)).toBe(inSample("order-42", 50));
  });

  it("roughly matches the requested percentage", () => {
    let included = 0;
    const total = 1000;
    for (let i = 0; i < total; i += 1) {
      if (inSample(`order-${i}`, 20)) included += 1;
    }
    // Deterministic hash, so this is a fixed number, not flaky: assert a band.
    expect(included).toBeGreaterThan(total * 0.1);
    expect(included).toBeLessThan(total * 0.3);
  });
});

import { describe, expect, it } from "vitest";

import {
  confidenceFor,
  confidenceForNumeric,
  marginOfError,
  MIN_ANSWERS,
  shouldLearnAndStop,
} from "@shared/templates/confidence";
import {
  pickFromRotation,
  matchesPaymentRule,
  rotationGroup,
  type CompiledSurvey,
  type Placement,
} from "@shared/survey-config";
import {
  diffSurvey,
  diffHasRemovedWithAnswers,
  getReadiness,
  readinessBlocksGoLive,
} from "@shared/templates/readiness";
import { validateSurveyDefinition } from "@shared/survey-rules";

function survey(id: string, over: Partial<CompiledSurvey> = {}): CompiledSurvey {
  return {
    id,
    version: 1,
    priority: 0,
    placements: ["thank_you"],
    layout: "all",
    title: "T",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks",
    channelReportQuestionId: null,
    targeting: {},
    questions: [],
    ...over,
  };
}

describe("confidence meter (T9)", () => {
  it("is Too early below 30 answers even when the share is extreme", () => {
    expect(confidenceFor(29, 0.9)).toBe("too_early");
    expect(confidenceFor(0, 0.5)).toBe("too_early");
  });

  it("walks the boundaries by margin of error", () => {
    // n=30, p=0.5 -> MoE ~ 0.179 > 0.15 -> early signal
    expect(confidenceFor(30, 0.5)).toBe("early_signal");
    // n=50, p=0.5 -> MoE ~ 0.139 (0.10–0.15) -> getting clear
    expect(confidenceFor(50, 0.5)).toBe("getting_clear");
    // n=100, p=0.5 -> MoE ~ 0.098 <= 0.10 -> reliable
    expect(confidenceFor(100, 0.5)).toBe("reliable");
  });

  it("computes the margin of error, and null for no answers", () => {
    expect(marginOfError(0, 0.5)).toBeNull();
    expect(marginOfError(100, 0.5)).toBeCloseTo(0.098, 2);
  });

  it("labels numeric questions by count", () => {
    expect(confidenceForNumeric(29)).toBe("too_early");
    expect(confidenceForNumeric(30)).toBe("early_signal");
    expect(confidenceForNumeric(60)).toBe("getting_clear");
    expect(confidenceForNumeric(100)).toBe("reliable");
  });

  it("keeps MIN_ANSWERS at 30", () => {
    expect(MIN_ANSWERS).toBe(30);
  });
});

describe("learn & stop (T10)", () => {
  it("fires for a choice question only at reliable and n>=100", () => {
    expect(shouldLearnAndStop({ enabled: true, isNumeric: false, n: 99, topShare: 0.5 })).toBe(false);
    expect(shouldLearnAndStop({ enabled: true, isNumeric: false, n: 100, topShare: 0.5 })).toBe(true);
  });

  it("uses n>=150 for numeric questions", () => {
    expect(shouldLearnAndStop({ enabled: true, isNumeric: true, n: 149, topShare: 0 })).toBe(false);
    expect(shouldLearnAndStop({ enabled: true, isNumeric: true, n: 150, topShare: 0 })).toBe(true);
  });

  it("never fires when disabled", () => {
    expect(shouldLearnAndStop({ enabled: false, isNumeric: false, n: 1000, topShare: 0.5 })).toBe(false);
  });
});

describe("rotation (T11)", () => {
  const group = [survey("a"), survey("b"), survey("c")];

  it("is deterministic per order id", () => {
    expect(pickFromRotation(group, "5001")?.id).toBe(pickFromRotation(group, "5001")?.id);
  });

  it("agrees between the two surfaces because both pass the same order id", () => {
    const thankYou = pickFromRotation(group, "777")?.id;
    const orderStatus = pickFromRotation(group, "777")?.id;
    expect(thankYou).toBe(orderStatus);
  });

  it("distributes within 5% of weights over 10,000 seeds", () => {
    const weighted = [survey("a", { rotationWeight: 1 }), survey("b", { rotationWeight: 2 }), survey("c", { rotationWeight: 3 })];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const total = 10_000;
    for (let i = 0; i < total; i += 1) {
      const picked = pickFromRotation(weighted, `order-${i}`)!;
      counts[picked.id] = (counts[picked.id] ?? 0) + 1;
    }
    const expected = { a: 1 / 6, b: 2 / 6, c: 3 / 6 };
    for (const id of ["a", "b", "c"] as const) {
      const share = counts[id]! / total;
      expect(Math.abs(share - expected[id]), `share ${id}=${share.toFixed(3)}`).toBeLessThan(0.05);
    }
  });

  it("returns the only member when the group has one", () => {
    expect(pickFromRotation([survey("only")], "x")?.id).toBe("only");
  });

  it("builds the group from matching rotation members only", () => {
    const surveys = [
      survey("rot", { rotation: true }),
      survey("solo", { rotation: false }),
      survey("other", { rotation: true, placements: ["order_status"] }),
    ];
    const g = rotationGroup(surveys, "thank_you", () => true);
    expect(g.map((s) => s.id)).toEqual(["rot"]);
  });
});

describe("payment-method targeting (T7)", () => {
  const manual = survey("m", { paymentManualOnly: true });

  it("matches a manual payment option on the thank-you page", () => {
    expect(matchesPaymentRule(manual, ["manualPayment"], "thank_you")).toBe(true);
  });

  it("matches a payment collected on delivery (the COD case the plan names)", () => {
    // Verified against the installed @shopify/ui-extensions type union:
    // `paymentOnDelivery` is distinct from `manualPayment`, and a COD shop can
    // report either, so both must match.
    expect(matchesPaymentRule(manual, ["paymentOnDelivery"], "thank_you")).toBe(true);
  });

  it("does not match card payments", () => {
    expect(matchesPaymentRule(manual, ["creditCard"], "thank_you")).toBe(false);
  });

  it("treats an empty list as not matched", () => {
    expect(matchesPaymentRule(manual, [], "thank_you")).toBe(false);
  });

  it("never applies off the thank-you page", () => {
    expect(matchesPaymentRule(manual, ["manualPayment"], "order_status")).toBe(false);
    expect(matchesPaymentRule(manual, ["paymentOnDelivery"], "order_status")).toBe(false);
  });

  it("ignores the rule when the survey does not use it", () => {
    expect(matchesPaymentRule(survey("x"), [], "order_status")).toBe(true);
  });
});

describe("diffSurvey (S8)", () => {
  const base = {
    title: "Quick question",
    intro: "Hi",
    buttonLabel: "Submit",
    thankYouText: "Thanks",
    placements: ["thank_you"],
    audience: "everyone",
    design: { ratingStyle: "numbers" },
    questions: [
      { id: "q1", text: "A", options: [{ id: "o1", label: "One" }, { id: "o2", label: "Two" }] },
    ],
  };

  it("reports no changes when identical", () => {
    expect(diffSurvey(base, base)).toEqual([]);
  });

  it("detects question text, added and removed items", () => {
    const draft = {
      ...base,
      questions: [
        { id: "q1", text: "A changed", options: [{ id: "o1", label: "One" }, { id: "o3", label: "Three" }] },
        { id: "q2", text: "New question" },
      ],
    };
    const changes = diffSurvey(base, draft);
    expect(changes).toContainEqual({ kind: "question_text", questionIndex: 0 });
    expect(changes).toContainEqual({ kind: "question_added", questionIndex: 1 });
    expect(changes).toContainEqual({ kind: "option_added", questionIndex: 0, label: "Three" });
    expect(changes).toContainEqual({ kind: "option_removed", questionIndex: 0, label: "Two", hasAnswers: false });
  });

  it("flags a removed question that still has answers", () => {
    const draft = { ...base, questions: [] };
    const changes = diffSurvey(base, draft, (qid) => qid === "q1");
    const removed = changes.find((c) => c.kind === "question_removed");
    expect(removed).toEqual({ kind: "question_removed", questionIndex: 0, hasAnswers: true });
    expect(diffHasRemovedWithAnswers(changes)).toBe(true);
  });

  it("detects placements, audience and design changes", () => {
    const draft = {
      ...base,
      placements: ["thank_you", "order_status"],
      audience: "returning",
      design: { ratingStyle: "stars" },
    };
    const changes = diffSurvey(base, draft);
    expect(changes).toContainEqual({ kind: "placement_added", placement: "order_status" });
    expect(changes).toContainEqual({ kind: "audience", audience: "returning" });
    expect(changes).toContainEqual({ kind: "design", field: "ratingStyle", value: "stars" });
  });
});

describe("getReadiness (S9)", () => {
  const good = {
    name: "n",
    title: "t",
    buttonLabel: "Submit",
    thankYouText: "Thanks",
    questions: [{ id: "q1", type: "single_choice" as const, text: "Hi", required: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
  };

  it("passes when everything is in order", () => {
    const items = getReadiness({ definition: good, placements: ["thank_you"], maxQuestions: 5, overActiveLimit: false });
    expect(readinessBlocksGoLive(items)).toBe(false);
  });

  it("blocks with no placement", () => {
    const items = getReadiness({ definition: good, placements: [], maxQuestions: 5, overActiveLimit: false });
    expect(readinessBlocksGoLive(items)).toBe(true);
    expect(items.find((i) => i.id === "has_placement")?.ok).toBe(false);
  });

  it("blocks invalid questions", () => {
    const bad = { ...good, questions: [{ id: "q1", type: "single_choice" as const, text: "", required: true, options: [{ id: "a", label: "A" }] }] };
    const items = getReadiness({ definition: bad, placements: ["thank_you"], maxQuestions: 5, overActiveLimit: false });
    expect(readinessBlocksGoLive(items)).toBe(true);
    expect(items.find((i) => i.id === "valid_questions")?.ok).toBe(false);
  });

  it("blocks when over the plan question limit", () => {
    const items = getReadiness({ definition: good, placements: ["thank_you"], maxQuestions: 0, overActiveLimit: false });
    expect(items.find((i) => i.id === "fits_plan")?.ok).toBe(false);
  });

  it("treats a missing block as a non-blocking warning only when known false", () => {
    const unknown = getReadiness({ definition: good, placements: ["thank_you"], maxQuestions: 5, overActiveLimit: false, blockAdded: null });
    expect(unknown.find((i) => i.id === "block_added")?.ok).toBe(true);
    const missing = getReadiness({ definition: good, placements: ["thank_you"], maxQuestions: 5, overActiveLimit: false, blockAdded: false });
    expect(readinessBlocksGoLive(missing)).toBe(false);
    expect(missing.find((i) => i.id === "block_added")?.ok).toBe(false);
  });

  it("keeps the shared validator as the source of the valid check", () => {
    expect(validateSurveyDefinition(good)).toEqual([]);
  });
});

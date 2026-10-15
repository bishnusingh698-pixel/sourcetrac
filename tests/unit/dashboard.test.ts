/**
 * The Dashboard's own arithmetic: shop-wide NPS / CSAT, the per-order buyer
 * split and which surveys get a row. These are the numbers a merchant reads
 * first, so each rule that could quietly skew them is pinned here.
 */
import { describe, expect, it } from "vitest";

import { buildScoreSummary, buyerMix, pickDashboardSurveys, scoreAnswerValue } from "~/lib/dashboard.server";
import { parseDashboardRange } from "~/lib/dashboard-range";
import type { SurveyAnswerRow, SurveyResponseRow } from "~/lib/survey-analytics.server";

function answer(questionId: string, over: Partial<SurveyAnswerRow> = {}): SurveyAnswerRow {
  return { questionId, optionIds: [], numberValue: null, textValue: null, otherText: null, ...over };
}

function response(over: Partial<SurveyResponseRow> & Pick<SurveyResponseRow, "id" | "surveyId">): SurveyResponseRow {
  return {
    orderId: null,
    orderNumber: null,
    orderTotal: null,
    currency: null,
    placement: "thank_you",
    flagged: false,
    verified: true,
    unverifiedFailed: false,
    createdAt: new Date("2026-10-10T12:00:00Z"),
    isFirstOrder: null,
    productIds: [],
    answers: [],
    order: null,
    ...over,
  };
}

/** One NPS answer per value, `count` times. */
function npsAnswers(surveyId: string, questionId: string, values: number[], prefix: string): SurveyResponseRow[] {
  return values.map((value, index) =>
    response({ id: `${prefix}-${index}`, surveyId, answers: [answer(questionId, { numberValue: value })] }),
  );
}

const SURVEYS = [
  {
    id: "s-loyalty",
    name: "Loyalty pulse",
    questions: [
      { id: "q-nps-a", type: "nps", text: "How likely are you to recommend us?" },
      { id: "q-channel", type: "single_choice", text: "Where did you hear about us?" },
    ],
  },
  {
    id: "s-delivery",
    name: "Delivery check",
    questions: [
      { id: "q-nps-b", type: "nps", text: "Would you recommend us to a friend?" },
      { id: "q-rating", type: "rating_5", text: "Rate your delivery" },
      { id: "q-sat", type: "satisfaction_5", text: "How satisfied are you?" },
    ],
  },
];

describe("buildScoreSummary", () => {
  it("pools NPS over every answer, not as an average of each question's score", () => {
    // Question A: 4 promoters out of 4 -> +100. Question B: 2 promoters and 10
    // detractors out of 12 -> -67.
    const responses = [
      ...npsAnswers("s-loyalty", "q-nps-a", [10, 10, 9, 9], "a"),
      ...npsAnswers("s-delivery", "q-nps-b", [10, 9, ...Array(10).fill(2)], "b"),
    ];
    const summary = buildScoreSummary({ responses, surveys: SURVEYS });

    // (6 promoters - 10 detractors) / 16 answers = -25. An average of +100 and
    // -67 would read +17: a merchant would see a positive NPS that is not.
    expect(summary.nps?.result).toEqual({ score: -25, promoters: 6, passives: 0, detractors: 10, total: 16 });
    expect(summary.nps?.questions).toBe(2);
    // Two surveys behind it: the tile links to Results, not one survey.
    expect(summary.nps?.surveyId).toBeNull();
    // Most-answered question first.
    expect(summary.cards.map((c) => c.questionId)).toEqual(["q-nps-b", "q-nps-a"]);
  });

  it("pools 1–5 ratings and satisfaction answers into one CSAT, including id-only satisfaction answers", () => {
    const responses = [
      response({ id: "r1", surveyId: "s-delivery", answers: [answer("q-rating", { numberValue: 5 })] }),
      response({ id: "r2", surveyId: "s-delivery", answers: [answer("q-rating", { numberValue: 2 })] }),
      // Older satisfaction answers stored only the level id.
      response({ id: "r3", surveyId: "s-delivery", answers: [answer("q-sat", { optionIds: ["very_satisfied"] })] }),
      response({ id: "r4", surveyId: "s-delivery", answers: [answer("q-sat", { optionIds: ["satisfied"], numberValue: 4 })] }),
    ];
    const summary = buildScoreSummary({ responses, surveys: SURVEYS });

    expect(summary.csat?.result).toEqual({ percent: 75, satisfied: 3, total: 4, average: 4 });
    expect(summary.csat?.questions).toBe(2);
    expect(summary.csat?.surveyId).toBe("s-delivery");
    expect(summary.nps).toBeNull();
  });

  it("is null with no answers, never a fabricated 0, but still says which scores are asked", () => {
    const summary = buildScoreSummary({ responses: [], surveys: SURVEYS });
    expect(summary.nps).toBeNull();
    expect(summary.csat).toBeNull();
    expect(summary.cards).toEqual([]);
    expect(summary.asks).toEqual({ nps: true, csat: true });

    const none = buildScoreSummary({ responses: [], surveys: [SURVEYS[0]!].map((s) => ({ ...s, questions: [s.questions[1]!] })) });
    expect(none.asks).toEqual({ nps: false, csat: false });
  });

  it("only counts an answer for a question its own survey asks", () => {
    // A response to the delivery survey cannot carry an answer to the loyalty
    // survey's question; if one does, it must not move the loyalty score.
    const responses = [
      response({ id: "x", surveyId: "s-delivery", answers: [answer("q-nps-a", { numberValue: 0 })] }),
      response({ id: "y", surveyId: "s-loyalty", answers: [answer("q-nps-a", { numberValue: 10 })] }),
    ];
    const summary = buildScoreSummary({ responses, surveys: SURVEYS });
    expect(summary.nps?.result.total).toBe(1);
    expect(summary.nps?.result.score).toBe(100);
    expect(summary.nps?.surveyId).toBe("s-loyalty");
  });
});

describe("scoreAnswerValue", () => {
  it("reads numberValue first and falls back to the satisfaction level id", () => {
    expect(scoreAnswerValue("nps", answer("q", { numberValue: 7 }))).toBe(7);
    expect(scoreAnswerValue("satisfaction_5", answer("q", { optionIds: ["dissatisfied"] }))).toBe(2);
    expect(scoreAnswerValue("satisfaction_5", answer("q", { optionIds: ["nope"] }))).toBeNull();
    expect(scoreAnswerValue("rating_5", answer("q"))).toBeNull();
  });
});

describe("buyerMix", () => {
  const paid = (orderId: string, total: string) => ({
    orderId,
    orderTotal: total,
    currency: "USD",
    order: { currency: "USD", totalPrice: total, financialStatus: "paid", isTest: false, isCancelled: false },
  });

  it("never counts an order twice, even if it has two answer rows", () => {
    // `submitAnswers` stores one answer set per order, but this figure sums
    // revenue across surveys, so a second row must not double the buyer.
    const buyers = buyerMix([
      response({ id: "a", surveyId: "s-loyalty", isFirstOrder: true, ...paid("1001", "50.00") }),
      response({ id: "b", surveyId: "s-delivery", isFirstOrder: true, ...paid("1001", "50.00") }),
      response({ id: "c", surveyId: "s-loyalty", isFirstOrder: false, ...paid("1002", "30.00") }),
    ]);
    expect(buyers.first).toEqual({ responses: 1, revenueByCurrency: [{ currency: "USD", minor: 5000, orders: 1 }] });
    expect(buyers.returning).toEqual({ responses: 1, revenueByCurrency: [{ currency: "USD", minor: 3000, orders: 1 }] });
    expect(buyers.unknown).toBe(0);
  });

  it("keeps the answer that knows whether it was a first order, and leaves out answers with no order", () => {
    const buyers = buyerMix([
      response({ id: "a", surveyId: "s-loyalty", isFirstOrder: null, ...paid("1001", "50.00") }),
      response({ id: "b", surveyId: "s-delivery", isFirstOrder: false, ...paid("1001", "50.00") }),
      // On-site answer: no order, so no buyer history and no revenue.
      response({ id: "c", surveyId: "s-loyalty", isFirstOrder: null }),
    ]);
    expect(buyers.returning.responses).toBe(1);
    expect(buyers.first.responses).toBe(0);
    expect(buyers.unknown).toBe(0);
  });
});

describe("pickDashboardSurveys", () => {
  it("lists live surveys and any other with answers, busiest first, in priority order on ties", () => {
    const surveys = [
      { id: "live-quiet", status: "active" },
      { id: "paused-busy", status: "paused" },
      { id: "draft-empty", status: "draft" },
      { id: "live-busy", status: "active" },
    ];
    const answers = new Map([
      ["paused-busy", 4],
      ["live-busy", 9],
    ]);
    expect(pickDashboardSurveys(surveys, answers).map((s) => s.id)).toEqual(["live-busy", "paused-busy", "live-quiet"]);
    expect(pickDashboardSurveys(surveys, answers, 2).map((s) => s.id)).toEqual(["live-busy", "paused-busy"]);
  });
});

describe("parseDashboardRange", () => {
  it("accepts the offered ranges and falls back to 30 days", () => {
    expect(parseDashboardRange("7")).toBe(7);
    expect(parseDashboardRange("90")).toBe(90);
    expect(parseDashboardRange("365")).toBe(30);
    expect(parseDashboardRange(null)).toBe(30);
  });
});

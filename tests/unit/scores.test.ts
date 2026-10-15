import { describe, expect, it } from "vitest";

import { buildBreakdowns, questionScore, type SurveyResponseRow } from "~/lib/survey-analytics.server";
import { csatResult, npsResult } from "@shared/survey-rules";

/**
 * NPS and CSAT are the numbers a merchant reads first on Results, so their
 * arithmetic and their "no answers yet" case are pinned here. A missing score
 * must stay null (no badge), never a fabricated 0.
 */

describe("npsResult", () => {
  it("splits promoters, passives and detractors", () => {
    // 6 promoters, 2 passives, 2 detractors out of 10 -> 60% - 20% = +40
    expect(
      npsResult([
        { value: 10, count: 4 },
        { value: 9, count: 2 },
        { value: 8, count: 1 },
        { value: 7, count: 1 },
        { value: 6, count: 1 },
        { value: 0, count: 1 },
      ]),
    ).toEqual({ score: 40, promoters: 6, passives: 2, detractors: 2, total: 10 });
  });

  it("is null with no answers", () => {
    expect(npsResult([])).toBeNull();
    expect(npsResult([{ value: 9, count: 0 }])).toBeNull();
  });

  it("ignores values that are not 0–10 answers", () => {
    expect(npsResult([{ value: 11, count: 5 }, { value: -1, count: 5 }, { value: 9.5, count: 5 }])).toBeNull();
    expect(npsResult([{ value: 10, count: 1 }, { value: 42, count: 9 }])).toEqual({
      score: 100,
      promoters: 1,
      passives: 0,
      detractors: 0,
      total: 1,
    });
  });
});

describe("csatResult", () => {
  it("is the share of 4s and 5s, with the average", () => {
    // 3 of 4 answers are 4 or 5 -> 75%; mean (5+4+4+1)/4 = 3.5
    expect(
      csatResult([
        { value: 5, count: 1 },
        { value: 4, count: 2 },
        { value: 1, count: 1 },
      ]),
    ).toEqual({ percent: 75, satisfied: 3, total: 4, average: 3.5 });
  });

  it("is null with no answers and ignores values outside 1–5", () => {
    expect(csatResult([])).toBeNull();
    expect(csatResult([{ value: 0, count: 3 }, { value: 6, count: 3 }])).toBeNull();
  });
});

describe("questionScore", () => {
  it("gives NPS to NPS questions and CSAT to ratings and satisfaction", () => {
    expect(questionScore("nps", [{ value: 10, count: 1 }])?.kind).toBe("nps");
    expect(questionScore("rating_5", [{ value: 5, count: 1 }])?.kind).toBe("csat");
    expect(questionScore("satisfaction_5", [{ value: 4, count: 1 }])?.kind).toBe("csat");
    expect(questionScore("single_choice", [{ value: 1, count: 1 }])).toBeNull();
  });
});

function response(id: string, answer: SurveyResponseRow["answers"][number]): SurveyResponseRow {
  return {
    id,
    orderId: null,
    orderTotal: null,
    currency: null,
    verified: null,
    unverifiedFailed: false,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    answers: [answer],
    order: null,
  } as unknown as SurveyResponseRow;
}

describe("buildBreakdowns scores", () => {
  it("scores an NPS question from its answers", () => {
    const [breakdown] = buildBreakdowns({
      questions: [{ id: "q", type: "nps", options: [] }],
      responses: [
        response("a", { questionId: "q", optionIds: [], numberValue: 10, textValue: null, otherText: null }),
        response("b", { questionId: "q", optionIds: [], numberValue: 3, textValue: null, otherText: null }),
        response("c", { questionId: "q", optionIds: [], numberValue: 8, textValue: null, otherText: null }),
      ] as SurveyResponseRow[],
    });
    expect(breakdown?.kind).toBe("numeric");
    expect(breakdown && "score" in breakdown ? breakdown.score : undefined).toMatchObject({
      kind: "nps",
      score: 0,
      promoters: 1,
      passives: 1,
      detractors: 1,
    });
  });

  it("scores a satisfaction question from its fixed option ids", () => {
    const [breakdown] = buildBreakdowns({
      questions: [{ id: "q", type: "satisfaction_5", options: [] }],
      responses: [
        response("a", { questionId: "q", optionIds: ["very_satisfied"], numberValue: null, textValue: null, otherText: null }),
        response("b", { questionId: "q", optionIds: ["satisfied"], numberValue: null, textValue: null, otherText: null }),
        response("c", { questionId: "q", optionIds: ["dissatisfied"], numberValue: null, textValue: null, otherText: null }),
      ] as SurveyResponseRow[],
    });
    expect(breakdown?.kind).toBe("choice");
    expect(breakdown && "score" in breakdown ? breakdown.score : undefined).toMatchObject({
      kind: "csat",
      percent: 67,
      satisfied: 2,
      total: 3,
      average: 3.7,
    });
  });

  it("has no score for a question nobody answered", () => {
    const [breakdown] = buildBreakdowns({ questions: [{ id: "q", type: "nps", options: [] }], responses: [] });
    expect(breakdown && "score" in breakdown ? breakdown.score : undefined).toBeNull();
  });
});

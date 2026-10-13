import { describe, expect, it } from "vitest";

import {
  buildCrossTab,
  buildIdeaStats,
  buildProductBreakdown,
  buildQuestionStats,
  CROSS_TAB_MIN,
  crossTabRowShares,
  mainQuestion,
  type StatsQuestion,
  type StatsResponse,
} from "@shared/templates/stats";
import { computeIdeas } from "@shared/templates/ideas";

function choiceQuestion(id: string, optionIds: string[]): StatsQuestion {
  return { id, type: "single_choice", options: optionIds.map((oid) => ({ id: oid, label: oid, archived: false })) };
}

function answer(questionId: string, optionIds: string[]): { questionId: string; optionIds: string[]; numberValue: null; textValue: null; otherText: null } {
  return { questionId, optionIds, numberValue: null, textValue: null, otherText: null };
}

function response(questionId: string, optionIds: string[], productIds: string[] = []): StatsResponse {
  return { productIds, answers: [answer(questionId, optionIds)] };
}

describe("buildQuestionStats", () => {
  const question = choiceQuestion("q", ["a", "b", "c"]);

  it("computes shares and the top answer", () => {
    const responses = [
      ...Array.from({ length: 6 }, () => response("q", ["a"])),
      ...Array.from({ length: 3 }, () => response("q", ["b"])),
      response("q", ["c"]),
    ];
    const stats = buildQuestionStats(responses, question);
    expect(stats.n).toBe(10);
    expect(stats.shares["a"]).toBeCloseTo(0.6);
    expect(stats.topOptionKey).toBe("a");
    expect(stats.topShare).toBeCloseTo(0.6);
  });

  it("breaks ties on option display order, not insertion order", () => {
    const responses = [response("q", ["c"]), response("q", ["a"])];
    const stats = buildQuestionStats(responses, question);
    expect(stats.topOptionKey).toBe("a");
  });

  it("is 'too early' below 30 answers", () => {
    const responses = Array.from({ length: 29 }, () => response("q", ["a"]));
    expect(buildQuestionStats(responses, question).confidence).toBe("too_early");
  });

  it("labels a numeric question by count and averages it", () => {
    const numeric: StatsQuestion = { id: "r", type: "rating_5", options: [] };
    const responses: StatsResponse[] = [4, 5, 3].map((value) => ({
      productIds: [],
      answers: [{ questionId: "r", optionIds: [], numberValue: value, textValue: null, otherText: null }],
    }));
    const stats = buildQuestionStats(responses, numeric);
    expect(stats.n).toBe(3);
    expect(stats.average).toBe(4);
    expect(stats.confidence).toBe("too_early");
  });

  it("computes NPS shares for an nps question", () => {
    const nps: StatsQuestion = { id: "n", type: "nps", options: [] };
    const values = [10, 9, 8, 5, 3];
    const responses: StatsResponse[] = values.map((value) => ({
      productIds: [],
      answers: [{ questionId: "n", optionIds: [], numberValue: value, textValue: null, otherText: null }],
    }));
    const stats = buildQuestionStats(responses, nps);
    expect(stats.nps?.promoter).toBeCloseTo(0.4);
    expect(stats.nps?.passive).toBeCloseTo(0.2);
    expect(stats.nps?.detractor).toBeCloseTo(0.4);
  });
});

describe("mainQuestion", () => {
  it("picks the first distribution question and skips free text", () => {
    const questions: StatsQuestion[] = [
      { id: "t", type: "text", options: [] },
      choiceQuestion("c", ["a"]),
    ];
    expect(mainQuestion(questions)?.id).toBe("c");
  });
});

describe("buildProductBreakdown (T8)", () => {
  const question = choiceQuestion("q", ["good", "bad"]);

  function make(productIds: string[], option: string): StatsResponse {
    return response("q", [option], productIds);
  }

  it("groups by product and drops products below the minimum", () => {
    const responses: StatsResponse[] = [];
    for (let i = 0; i < 12; i += 1) responses.push(make(["p1"], i < 6 ? "good" : "bad"));
    for (let i = 0; i < 4; i += 1) responses.push(make(["p2"], "good"));

    const rows = buildProductBreakdown({ responses, question, productTitles: { p1: "Widget", p2: "Gadget" }, minResponses: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.productId).toBe("p1");
    expect(rows[0]?.productTitle).toBe("Widget");
    expect(rows[0]?.n).toBe(12);
    expect(rows[0]?.shares["good"]).toBeCloseTo(0.5);
  });

  it("counts a multi-product order toward each product", () => {
    const responses = Array.from({ length: 10 }, () => make(["p1", "p2"], "good"));
    const rows = buildProductBreakdown({ responses, question, productTitles: {}, minResponses: 10 });
    expect(rows.map((r) => r.productId).sort()).toEqual(["p1", "p2"]);
  });

  it("caps the number of products", () => {
    const responses: StatsResponse[] = [];
    for (let p = 0; p < 25; p += 1) {
      for (let i = 0; i < 10; i += 1) responses.push(make([`p${p}`], "good"));
    }
    const rows = buildProductBreakdown({ responses, question, productTitles: {}, minResponses: 10, maxProducts: 20 });
    expect(rows).toHaveLength(20);
  });
});

describe("buildCrossTab (T14)", () => {
  const rowQ = choiceQuestion("a", ["x", "y"]);
  const colQ = choiceQuestion("b", ["1", "2"]);

  function pair(a: string, b: string): StatsResponse {
    return { productIds: [], answers: [answer("a", [a]), answer("b", [b])] };
  }

  it("counts only responses that answered both questions", () => {
    const responses = [pair("x", "1"), pair("x", "1"), pair("y", "2"), response("a", ["x"])];
    const tab = buildCrossTab({ responses, rowQuestion: rowQ, colQuestion: colQ });
    expect(tab.total).toBe(3);
    expect(tab.cells["x"]?.["1"]).toBe(2);
    expect(tab.cells["y"]?.["2"]).toBe(1);
  });

  it("requires at least 30 shared answers", () => {
    const few = buildCrossTab({ responses: [pair("x", "1")], rowQuestion: rowQ, colQuestion: colQ });
    expect(few.enough).toBe(false);
    const many = buildCrossTab({
      responses: Array.from({ length: CROSS_TAB_MIN }, () => pair("x", "1")),
      rowQuestion: rowQ,
      colQuestion: colQ,
    });
    expect(many.enough).toBe(true);
  });

  it("computes row shares against the row total", () => {
    const responses = [pair("x", "1"), pair("x", "1"), pair("x", "2")];
    const tab = buildCrossTab({ responses, rowQuestion: rowQ, colQuestion: colQ });
    const shares = crossTabRowShares(tab, "x");
    expect(shares["1"]).toBeCloseTo(2 / 3);
    expect(shares["2"]).toBeCloseTo(1 / 3);
  });
});

describe("buildIdeaStats (T12)", () => {
  it("feeds the idea rules and fires a matching card", () => {
    const question = choiceQuestion("q", ["instagram", "tiktok", "other"]);
    const responses = [
      ...Array.from({ length: 45 }, () => response("q", ["instagram"])),
      ...Array.from({ length: 55 }, () => response("q", ["tiktok"])),
    ];
    const stats = buildIdeaStats({ responses, questions: [question] });
    expect(stats.n).toBe(100);
    expect(stats.confidence).toBe("reliable");

    const ideas = computeIdeas(stats, ["channel_share"]);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.params.channel).toBe("tiktok");
  });

  it("does not fire a reliable-only rule at getting_clear confidence", () => {
    const question = choiceQuestion("q", ["instagram", "tiktok"]);
    const responses = [
      ...Array.from({ length: 30 }, () => response("q", ["instagram"])),
      ...Array.from({ length: 20 }, () => response("q", ["tiktok"])),
    ];
    const stats = buildIdeaStats({ responses, questions: [question] });
    expect(stats.confidence).toBe("getting_clear");
    expect(computeIdeas(stats, ["channel_share"])).toHaveLength(0);
  });

  it("adds per-product stats only when asked", () => {
    const question = choiceQuestion("q", ["a"]);
    const responses = Array.from({ length: 12 }, () => response("q", ["a"], ["p1"]));
    const without = buildIdeaStats({ responses, questions: [question] });
    expect(without.byProduct).toHaveLength(0);
    const withProduct = buildIdeaStats({ responses, questions: [question], byProduct: true, productTitles: { p1: "Thing" } });
    expect(withProduct.byProduct).toHaveLength(1);
    expect(withProduct.byProduct[0]?.productTitle).toBe("Thing");
  });
});

/**
 * `buildSurveyInsights` wires a stored survey to the pure aggregation in
 * `shared/templates/stats.ts`. The maths is covered by `templates-stats.test.ts`;
 * this file covers the wiring, which is where the silent bugs live:
 *
 * - the cross-question view must resolve the template's `q_*` keys to the
 *   stable survey ids `buildSurveyDefinition` writes, or it never appears;
 * - ideas must only appear for a template survey, and their text must be
 *   interpolated, not left as `{channel}`.
 */

import { describe, expect, it } from "vitest";

import { buildSurveyDefinition } from "@shared/templates/resolve";
import { templateById } from "@shared/templates/index";
import { buildSurveyInsights } from "~/lib/insights.server";
import type { SurveyResponseRow } from "~/lib/survey-analytics.server";

function row(
  answers: Array<{ questionId: string; optionIds?: string[]; numberValue?: number | null }>,
  productIds: string[] = [],
): SurveyResponseRow {
  return {
    id: `r${Math.random()}`,
    surveyId: "s",
    isFirstOrder: null,
    orderId: null,
    orderNumber: null,
    orderTotal: null,
    currency: null,
    placement: "thank_you",
    flagged: false,
    verified: null,
    unverifiedFailed: false,
    createdAt: new Date(),
    productIds,
    answers: answers.map((a) => ({
      questionId: a.questionId,
      optionIds: a.optionIds ?? [],
      numberValue: a.numberValue ?? null,
      textValue: null,
      otherText: null,
    })),
    order: null,
  };
}

/** Build a survey's stored questions from a template, as the app does. */
function questionsFromTemplate(templateId: string) {
  const template = templateById(templateId);
  if (!template) throw new Error(`no template ${templateId}`);
  const definition = buildSurveyDefinition({ template, locale: "en", region: "us" });
  return definition.questions.map((q) => ({
    id: q.id,
    type: q.type,
    text: q.text,
    options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label, archived: false })),
  }));
}

describe("buildSurveyInsights — cross-question wiring", () => {
  const questions = questionsFromTemplate("channel-compass");
  const channelId = "channel_compass_q_channel";
  const whenId = "channel_compass_q_when";

  it("resolves the template's q_* keys to stable survey ids", () => {
    // 40 responses answer both questions, so the view has enough shared answers.
    const responses = Array.from({ length: 40 }, () =>
      row([
        { questionId: channelId, optionIds: ["channel_compass_q_channel_instagram"] },
        { questionId: whenId, optionIds: ["channel_compass_q_when_today"] },
      ]),
    );

    const insights = buildSurveyInsights({
      responses,
      questions,
      templateId: "channel-compass",
      locale: "en",
    });

    expect(insights.crossRowQuestionId).toBe(channelId);
    expect(insights.crossColQuestionId).toBe(whenId);
    expect(insights.crossTab?.enough).toBe(true);
  });

  it("omits the view when too few responses answered both questions", () => {
    const responses = Array.from({ length: 5 }, () =>
      row([
        { questionId: channelId, optionIds: ["channel_compass_q_channel_instagram"] },
        { questionId: whenId, optionIds: ["channel_compass_q_when_today"] },
      ]),
    );
    const insights = buildSurveyInsights({
      responses,
      questions,
      templateId: "channel-compass",
      locale: "en",
    });
    expect(insights.crossTab?.enough).toBe(false);
  });
});

describe("buildSurveyInsights — ideas", () => {
  it("interpolates idea text for a template survey", () => {
    const questions = questionsFromTemplate("channel-compass");
    const channelId = "channel_compass_q_channel";
    const responses = Array.from({ length: 40 }, () =>
      row([{ questionId: channelId, optionIds: ["channel_compass_q_channel_instagram"] }]),
    );

    const insights = buildSurveyInsights({
      responses,
      questions,
      templateId: "channel-compass",
      locale: "en",
    });

    expect(insights.ideas.length).toBeGreaterThan(0);
    // The share is interpolated, never left as a raw `{...}` placeholder.
    expect(insights.ideas[0]?.text ?? "").not.toMatch(/\{[a-z_]+\}/);
  });

  it("shows no ideas for a survey not created from a template", () => {
    const questions = questionsFromTemplate("channel-compass");
    const channelId = "channel_compass_q_channel";
    const responses = Array.from({ length: 40 }, () =>
      row([{ questionId: channelId, optionIds: ["channel_compass_q_channel_instagram"] }]),
    );

    const insights = buildSurveyInsights({
      responses,
      questions,
      templateId: null,
      locale: "en",
    });
    expect(insights.ideas).toEqual([]);
  });
});

describe("buildSurveyInsights — by product", () => {
  it("only builds a product breakdown when the template asks for one", () => {
    const questions = questionsFromTemplate("price-pulse");
    const priceId = "price_pulse_q_price";
    const responses = Array.from({ length: 12 }, () =>
      row([{ questionId: priceId, optionIds: ["price_pulse_q_price_fair"] }], ["111"]),
    );

    const insights = buildSurveyInsights({
      responses,
      questions,
      templateId: "price-pulse",
      locale: "en",
      productTitles: { "111": "Sample product" },
    });
    expect(insights.byProduct.length).toBe(1);
    expect(insights.byProduct[0]?.productTitle).toBe("Sample product");
  });
});

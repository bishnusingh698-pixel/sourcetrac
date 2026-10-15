/**
 * Reporting reads both answer stores (C4), and the Results/Responses decisions
 * agree with what the merchant should see (H7, H8, L71, M9, M32, M33, L68).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { submitAnswers } from "~/lib/answers.server";
import { computeStats } from "~/lib/analytics";
import { countChannelAnswers, fetchChannelLabels, fetchDashboardData } from "~/lib/analytics-queries.server";
import { upsertShop } from "~/lib/shop.server";
import { createSurvey } from "~/lib/surveys.server";
import {
  buildBreakdowns,
  currentOrderTotal,
  summariseSurvey,
  surveyRevenueStatus,
  type SurveyResponseRow,
} from "~/lib/survey-analytics.server";
import { buildQuestionStats } from "@shared/templates/stats";

const prisma = new PrismaClient();
const DOMAIN = "reporting-test.myshopify.com";
let shopId = "";
let surveyId = "";
let questionId = "";
let instagram = "";

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9900001", accessToken: null });
  shopId = shop.id;
  const survey = await createSurvey(shopId, {
    name: "Channels",
    status: "active",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [{ type: "single_choice", text: "Where?", required: true, options: [{ label: "Instagram" }, { label: "Google" }] }],
  });
  surveyId = survey.id;
  questionId = survey.questions[0]!.id;
  instagram = survey.questions[0]!.options[0]!.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

async function order(orderId: string, total: string, createdAt = new Date()) {
  await prisma.orderCache.create({
    data: {
      shopId,
      orderId,
      currency: "USD",
      totalPrice: total,
      financialStatus: "paid",
      isTest: false,
      isCancelled: false,
      createdAtShop: createdAt,
      updatedAtShop: createdAt,
    },
  });
}

describe("dashboard reads v2 answers (C4)", () => {
  it("counts a checkout-block answer with its revenue and the option's label", async () => {
    await order("9910000000001", "42.00");
    await submitAnswers({
      shopId,
      surveyId,
      surveyVersion: 1,
      orderId: "9910000000001",
      placement: "thank_you",
      locale: null,
      answers: [{ questionId, optionIds: [instagram] }],
      plan: "growth",
      definition: { questions: [{ id: questionId, type: "single_choice", text: "Q", options: [{ id: instagram, label: "Instagram" }] }] },
    });
    // A legacy answer the migration copied (bf-response-*) must count once.
    const legacy = await prisma.surveyResponse.create({
      data: { shopId, orderId: "9910000000002", channel: "google", submittedAt: new Date() },
    });
    await prisma.response.create({
      data: {
        id: `bf-response-${legacy.id}`,
        shopId,
        surveyId,
        surveyVersion: 1,
        orderId: "9910000000002",
        placement: "thank_you",
        // The migrated option id carries the legacy value; it reads as "google".
        answers: { create: { shopId, questionId, optionIds: JSON.stringify([`bf-option-${shopId}-google`]) } },
      },
    });

    const data = await fetchDashboardData({ shopId, days: 30 });
    expect(data.responses.map((r) => r.channel).sort()).toEqual(["google", instagram].sort());
    expect(data.decidedAmounts).toEqual([expect.objectContaining({ channel: instagram, minor: 4200 })]);
    expect(await countChannelAnswers(shopId)).toBe(2);
    expect((await fetchChannelLabels({ id: shopId, optionsJson: "[]", questionText: "Q" })).get(instagram)).toBe("Instagram");

    // M33: the rate's numerator is answered orders placed in the window.
    expect(data.rateResponses).toBe(1);
    expect(data.rateResponses).toBeLessThanOrEqual(data.ordersInWindow);
  });
});

describe("pending means still waiting (L71, M32)", () => {
  it("does not count a given-up answer as pending on the dashboard", () => {
    const { summary } = computeStats({
      responses: [
        { channel: "a", isLocked: false, reconciled: false, unreconcilable: true, submittedAt: new Date() },
        { channel: "a", isLocked: false, reconciled: false, unreconcilable: false, submittedAt: new Date() },
      ] as never,
      decidedAmounts: [],
      ordersInWindow: 2,
    });
    expect(summary.pendingResponses).toBe(1);
  });

  it("does not count order-less or written-off answers as pending in Results", () => {
    const base: SurveyResponseRow = {
      id: "r", surveyId: "s", isFirstOrder: null, orderId: "1", orderNumber: null, orderTotal: null, currency: null, placement: "thank_you",
      flagged: false, verified: false, unverifiedFailed: false, createdAt: new Date(), productIds: [], answers: [], order: null,
    };
    const summary = summariseSurvey([base, { ...base, orderId: null }, { ...base, unverifiedFailed: true }]);
    expect(summary.pendingResponses).toBe(1);
    expect(surveyRevenueStatus({ ...base, unverifiedFailed: true })).toBe("order not received");
    expect(surveyRevenueStatus({ ...base, orderId: null })).toBe("no order");
    expect(surveyRevenueStatus(base)).toBe("awaiting order");
  });
});

describe("order totals and fixed-option results (M9, H7, H8)", () => {
  const row = (over: Partial<SurveyResponseRow>): SurveyResponseRow => ({
    id: "r", surveyId: "s", isFirstOrder: null, orderId: "1", orderNumber: null, orderTotal: "100.000", currency: "USD", placement: "thank_you",
    flagged: false, verified: true, unverifiedFailed: false, createdAt: new Date(), productIds: [], answers: [], order: null,
    ...over,
  });

  it("shows the live order total, not the first snapshot", () => {
    const refunded = row({ order: { currency: "USD", totalPrice: "60.000", financialStatus: "partially_refunded", isTest: false, isCancelled: false } });
    expect(currentOrderTotal(refunded)).toEqual({ total: "60.00", currency: "USD" });
  });

  it("averages satisfaction answers stored only as a level id", () => {
    const stats = buildQuestionStats(
      [
        { productIds: [], answers: [{ questionId: "q", optionIds: ["satisfied"], numberValue: null }] },
        { productIds: [], answers: [{ questionId: "q", optionIds: ["very_satisfied"], numberValue: null }] },
      ] as never,
      { id: "q", type: "satisfaction_5", options: [] },
    );
    expect(stats.average).toBe(4.5);
  });

  it("draws bars for yes/no and satisfaction questions", () => {
    const [yesNo, satisfaction] = buildBreakdowns({
      responses: [
        row({ answers: [
          { questionId: "yn", optionIds: [], numberValue: 1, textValue: null, otherText: null },
          { questionId: "sat", optionIds: ["neutral"], numberValue: 3, textValue: null, otherText: null },
        ] }),
      ],
      questions: [
        { id: "yn", type: "yes_no", options: [] },
        { id: "sat", type: "satisfaction_5", options: [] },
      ],
    });
    expect(yesNo).toMatchObject({ kind: "choice", options: [{ optionId: "yes", count: 1 }, { optionId: "no", count: 0 }] });
    expect(satisfaction && satisfaction.kind === "choice" ? satisfaction.options.find((o) => o.optionId === "neutral")?.count : 0).toBe(1);
  });
});

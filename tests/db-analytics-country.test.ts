/**
 * F6: Analytics narrowed to buyers in one country, through the production
 * report loaders (`loadChannelReport`, `fetchSurveyResponses`) against Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { submitAnswers } from "~/lib/answers.server";
import { loadChannelReport } from "~/lib/channel-report.server";
import { answerCountries } from "~/lib/analytics-queries.server";
import { fetchSurveyResponses } from "~/lib/survey-analytics.server";
import { upsertShop } from "~/lib/shop.server";
import { createSurvey } from "~/lib/surveys.server";

const prisma = new PrismaClient();
const DOMAIN = "analytics-country-test.myshopify.com";
let shopId = "";
let surveyId = "";
let questionId = "";
const options: Record<string, string> = {};

async function answer(orderId: string, label: string, country: string | null, total: string) {
  const now = new Date();
  await prisma.orderCache.create({
    data: { shopId, orderId, currency: "EUR", totalPrice: total, financialStatus: "paid", isTest: false, isCancelled: false, createdAtShop: now, updatedAtShop: now },
  });
  await submitAnswers({
    shopId,
    surveyId,
    surveyVersion: 1,
    orderId,
    placement: "thank_you",
    locale: null,
    isFirstOrder: true,
    country,
    answers: [{ questionId, optionIds: [options[label]!] }],
    plan: "scale",
    definition: {
      questions: [
        {
          id: questionId,
          type: "single_choice",
          text: "Where?",
          options: Object.entries(options).map(([l, id]) => ({ id, label: l })),
        },
      ],
    },
  } as Parameters<typeof submitAnswers>[0]);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9860001" })).id;
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
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
  for (const option of survey.questions[0]!.options) options[option.label] = option.id;

  await answer("8100000001", "Instagram", "DE", "10.00");
  await answer("8100000002", "Instagram", "DE", "20.00");
  await answer("8100000003", "Google", "FR", "30.00");
  await answer("8100000004", "Google", null, "40.00");
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

const shop = () => prisma.shop.findUniqueOrThrow({ where: { id: shopId } });

describe("Analytics for one country (F6)", () => {
  it("lists the countries buyers answered from, busiest first", async () => {
    expect(await answerCountries(shopId)).toEqual([
      { code: "DE", count: 2 },
      { code: "FR", count: 1 },
    ]);
  });

  it("limits the channel report to that country's answers and revenue, and drops the answer rate", async () => {
    const all = await loadChannelReport({ shop: await shop(), days: 30, locale: "en-US" });
    expect(all.summary.totalResponses).toBe(4);
    expect(all.rateAvailable).toBe(true);

    const germany = await loadChannelReport({ shop: await shop(), days: 30, locale: "en-US", country: "DE" });
    expect(germany.summary.totalResponses).toBe(2);
    expect(germany.channels.map((c) => c.label)).toEqual(["Instagram"]);
    expect(germany.summary.revenue.map((r) => r.text)).toEqual(["€30.00"]);
    expect(germany.country).toBe("DE");
    expect(germany.rateAvailable).toBe(false);
    expect(germany.summary.responseRate).toBeNull();
  });

  it("limits Survey results the same way", async () => {
    const france = await fetchSurveyResponses({ shopId, surveyId, country: "FR" });
    expect(france).toHaveLength(1);
    expect(france[0]?.country).toBe("FR");
    expect(await fetchSurveyResponses({ shopId, surveyId })).toHaveLength(4);
  });

  it("lists only the chosen survey's countries and counts on Survey results (R6)", async () => {
    const other = await createSurvey(shopId, {
      name: "Second survey",
      status: "active",
      placements: ["thank_you"],
      layout: "all",
      title: "Quick question",
      intro: null,
      buttonLabel: "Submit",
      thankYouText: "Thanks!",
      questions: [{ type: "yes_no", text: "First time?", required: true }],
    });
    const now = new Date();
    await prisma.orderCache.create({
      data: { shopId, orderId: "8100000009", currency: "EUR", totalPrice: "5.00", financialStatus: "paid", isTest: false, isCancelled: false, createdAtShop: now, updatedAtShop: now },
    });
    await submitAnswers({
      shopId,
      surveyId: other.id,
      surveyVersion: 1,
      orderId: "8100000009",
      placement: "thank_you",
      locale: null,
      country: "JP",
      answers: [{ questionId: other.questions[0]!.id, numberValue: 1 }],
      plan: "scale",
      definition: { questions: [{ id: other.questions[0]!.id, type: "yes_no", text: "First time?" }] },
    } as Parameters<typeof submitAnswers>[0]);

    // Shop-wide (the Channels tab) includes Japan; the first survey never had a Japanese buyer.
    expect((await answerCountries(shopId)).map((c) => c.code)).toEqual(["DE", "FR", "JP"]);
    expect(await answerCountries(shopId, surveyId)).toEqual([
      { code: "DE", count: 2 },
      { code: "FR", count: 1 },
    ]);
    expect(await answerCountries(shopId, other.id)).toEqual([{ code: "JP", count: 1 }]);
  });
});

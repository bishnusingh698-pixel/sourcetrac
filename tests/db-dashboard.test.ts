/**
 * The Dashboard and the channel report's written-in answers, against real
 * Postgres, through `loadDashboard` itself: the function the home page calls.
 *
 * The shop runs two surveys at once, a channel question and an NPS question,
 * each answered on different orders (the app stores one answer set per order).
 * Before this page existed the NPS was only on Results; the merchant could not
 * find it from the home page at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { submitAnswers } from "~/lib/answers.server";
import { loadDashboard } from "~/lib/dashboard.server";
import { upsertShop } from "~/lib/shop.server";
import { createSurvey, type SurveyInput } from "~/lib/surveys.server";

const prisma = new PrismaClient();
const DOMAIN = "dashboard-test.myshopify.com";

let shopId = "";
const channels = { id: "", questionId: "", instagram: "", google: "", other: "" };
const loyalty = { id: "", questionId: "" };

function input(name: string, question: SurveyInput["questions"][number]): SurveyInput {
  return {
    name,
    status: "active",
    placements: ["thank_you"],
    layout: "all",
    title: name,
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [question],
  };
}

async function order(orderId: string, total: string) {
  const now = new Date();
  await prisma.orderCache.create({
    data: {
      shopId,
      orderId,
      currency: "USD",
      totalPrice: total,
      financialStatus: "paid",
      isTest: false,
      isCancelled: false,
      createdAtShop: now,
      updatedAtShop: now,
    },
  });
}

async function answerChannel(orderId: string, optionId: string, isFirstOrder: boolean, otherText?: string) {
  await submitAnswers({
    shopId,
    surveyId: channels.id,
    surveyVersion: 1,
    orderId,
    placement: "thank_you",
    locale: null,
    isFirstOrder,
    answers: [{ questionId: channels.questionId, optionIds: [optionId], ...(otherText ? { otherText } : {}) }],
    plan: "scale",
    definition: {
      questions: [
        {
          id: channels.questionId,
          type: "single_choice",
          text: "Where did you hear about us?",
          options: [
            { id: channels.instagram, label: "Instagram" },
            { id: channels.google, label: "Google" },
            { id: channels.other, label: "Other", isOther: true },
          ],
        },
      ],
    },
  } as Parameters<typeof submitAnswers>[0]);
}

async function answerNps(orderId: string, value: number, isFirstOrder: boolean | null) {
  await submitAnswers({
    shopId,
    surveyId: loyalty.id,
    surveyVersion: 1,
    orderId,
    placement: "order_status",
    locale: null,
    isFirstOrder,
    answers: [{ questionId: loyalty.questionId, numberValue: value }],
    plan: "scale",
    definition: {
      questions: [{ id: loyalty.questionId, type: "nps", text: "How likely are you to recommend us?", options: [] }],
    },
  } as Parameters<typeof submitAnswers>[0]);
}

async function shopRow() {
  return prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9900001", accessToken: null });
  shopId = shop.id;
  // Two live surveys need a paid plan.
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });

  const channelSurvey = await createSurvey(
    shopId,
    input("Channels", {
      type: "single_choice",
      text: "Where did you hear about us?",
      required: true,
      options: [{ label: "Instagram" }, { label: "Google" }, { label: "Other", isOther: true }],
    }),
  );
  const loyaltySurvey = await createSurvey(
    shopId,
    input("Loyalty", { type: "nps", text: "How likely are you to recommend us?", required: true }),
  );
  const [instagram, google, other] = channelSurvey.questions[0]!.options;
  Object.assign(channels, {
    id: channelSurvey.id,
    questionId: channelSurvey.questions[0]!.id,
    instagram: instagram!.id,
    google: google!.id,
    other: other!.id,
  });
  Object.assign(loyalty, { id: loyaltySurvey.id, questionId: loyaltySurvey.questions[0]!.id });

  // Placed after both surveys exist, so both answer rates cover all six.
  await order("9910000000001", "40.00");
  await order("9910000000002", "60.00");
  await order("9910000000003", "100.00");
  await order("9910000000004", "20.00");
  await order("9910000000005", "30.00");
  await order("9910000000006", "50.00");

  await answerChannel("9910000000001", channels.instagram, true);
  await answerChannel("9910000000002", channels.google, false);
  await answerChannel("9910000000003", channels.other, true, "A podcast about tea");

  // 2 promoters and 1 detractor; the last order did not say if it was a first.
  await answerNps("9910000000004", 10, true);
  await answerNps("9910000000005", 3, false);
  await answerNps("9910000000006", 9, null);
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("loadDashboard", () => {
  it("shows the shop's NPS, linked to the one survey that asks it", async () => {
    const dashboard = await loadDashboard({ shop: await shopRow(), days: 30, locale: "en-US" });

    // (2 promoters - 1 detractor) / 3 answers = +33.
    expect(dashboard.scores.nps?.result).toEqual({ score: 33, promoters: 2, passives: 0, detractors: 1, total: 3 });
    expect(dashboard.scores.nps?.surveyId).toBe(loyalty.id);
    // No rating or satisfaction question anywhere: no CSAT, and the page offers
    // to add one instead of showing 0%.
    expect(dashboard.scores.csat).toBeNull();
    expect(dashboard.scores.asks).toEqual({ nps: true, csat: false });
  });

  it("splits new from returning buyers across every survey", async () => {
    const dashboard = await loadDashboard({ shop: await shopRow(), days: 30, locale: "en-US" });

    // First orders: 40 + 100 (channel survey) + 20 (NPS survey).
    expect(dashboard.buyers.first).toEqual({
      orders: 3,
      share: 60,
      revenue: [{ currency: "USD", text: "$160.00" }],
      aov: [{ currency: "USD", text: "$53.33" }],
    });
    expect(dashboard.buyers.returning).toEqual({
      orders: 2,
      share: 40,
      revenue: [{ currency: "USD", text: "$90.00" }],
      aov: [{ currency: "USD", text: "$45.00" }],
    });
    expect(dashboard.buyers.unknown).toBe(1);
  });

  it("gives every live survey a row with its key result and answer rate", async () => {
    const dashboard = await loadDashboard({ shop: await shopRow(), days: 30, locale: "en-US" });
    const byId = new Map(dashboard.surveys.map((s) => [s.id, s]));

    const nps = byId.get(loyalty.id);
    expect(nps?.headline).toEqual({ kind: "nps", value: "+33" });
    expect(nps?.answers).toBe(3);
    // Three of the six orders placed since it started answered it.
    expect(nps?.answerRate).toBe(50);

    const channel = byId.get(channels.id);
    expect(channel?.headline?.kind).toBe("top");
    expect(channel?.answers).toBe(3);
    expect(channel?.revenue).toEqual([{ currency: "USD", text: "$200.00" }]);
  });

  it("carries the channel report's numbers, so the two pages agree", async () => {
    const dashboard = await loadDashboard({ shop: await shopRow(), days: 30, locale: "en-US" });

    expect(dashboard.report.summary.totalResponses).toBe(3);
    expect(dashboard.report.summary.revenue).toEqual([{ currency: "USD", text: "$200.00" }]);
    expect(dashboard.report.channels).toHaveLength(3);
    // What the buyer typed under "Other" reaches the channel report.
    expect(dashboard.report.otherAnswers.map((a) => a.text)).toEqual(["A podcast about tea"]);
    expect(dashboard.report.otherAnswers[0]?.label).toBe("Other");
  });

  it("reads nothing from outside the chosen range", async () => {
    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const dashboard = await loadDashboard({ shop: await shopRow(), days: 7, locale: "en-US", now: later });

    expect(dashboard.scores.nps).toBeNull();
    // The question still exists, so the page says "no answers in this period"
    // rather than offering to add an NPS survey the shop already has.
    expect(dashboard.scores.asks.nps).toBe(true);
    expect(dashboard.buyers.first.orders).toBe(0);
    expect(dashboard.report.summary.totalResponses).toBe(0);
  });
});

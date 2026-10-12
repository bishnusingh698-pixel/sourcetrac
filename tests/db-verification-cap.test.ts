/**
 * Order verification and the atomic Free-cap claim, against real Postgres.
 *
 * These pin two things a unit test cannot:
 *  - a v2 `Response` whose order arrives later is reconciled and marked verified
 *    (otherwise its revenue stays Pending forever), and a response for an order
 *    that never arrives is marked `unverifiedFailed` and excluded;
 *  - the Free cap is claimed with a conditional UPDATE, so twenty simultaneous
 *    claims can never let more than `cap` through.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import {
  capOf,
  claimUsageSlot,
  markUnverifiedFailedResponses,
  reconcileOrderForResponses,
  submitAnswers,
} from "~/lib/answers.server";
import { decideSurveyRevenue, fetchSurveyResponses } from "~/lib/survey-analytics.server";
import { FREE_RESPONSE_CAP, currentUtcPeriod, evaluateCap } from "~/lib/plans";
import { upsertShop } from "~/lib/shop.server";
import { createSurvey } from "~/lib/surveys.server";
import { processWebhook } from "~/lib/webhooks.server";

const prisma = new PrismaClient();

const DOMAIN = "verify-cap-test.myshopify.com";
const GID = "gid://shopify/Shop/9500001";

async function cleanup() {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
}

let shopId = "";
let surveyId = "";
let questionId = "";
let optionId = "";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: GID, accessToken: null });
  shopId = shop.id;
  const survey = await createSurvey(shopId, {
    name: "Verify",
    status: "active",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      {
        type: "single_choice",
        text: "How did you hear about us?",
        required: true,
        options: [{ label: "Instagram" }, { label: "Google search" }],
      },
    ],
  });
  surveyId = survey.id;
  const row = await prisma.question.findFirstOrThrow({
    where: { surveyId },
    include: { options: true },
  });
  questionId = row.id;
  optionId = row.options[0]!.id;
});

async function answer(shopId: string, orderId: string) {
  return submitAnswers({
    shopId,
    surveyId,
    surveyVersion: 1,
    orderId,
    placement: "thank_you",
    locale: null,
    answers: [{ questionId, optionIds: [optionId] }],
    plan: "growth",
    definition: { questions: [{ id: questionId, type: "single_choice", text: "Q", options: [{ id: optionId, label: "Instagram" }] }] },
  });
}

const orderPayload = (id: number, total = "100.00") =>
  ({
    id,
    currency: "USD",
    financial_status: "paid",
    test: false,
    cancelled_at: null,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:00:00Z",
    current_total_price: total,
  }) as unknown as Record<string, unknown>;

describe("order verification", () => {
  it("stores an answer before the order as unverified with a null total", async () => {
    await answer(shopId, "9600001");
    const row = await prisma.response.findFirstOrThrow({ where: { shopId } });
    expect(row.orderTotal).toBeNull();
    expect(row.verified).toBe(false);
    expect(row.unverifiedFailed).toBe(false);
  });

  it("reconciles and verifies a response when the order webhook lands later", async () => {
    await answer(shopId, "9600002");
    // No OrderCache yet -> orderTotal null, revenue excluded.
    let responses = await fetchSurveyResponses({ shopId, surveyId });
    expect(decideSurveyRevenue(responses[0]!)).toEqual({ included: false, reason: "unreconciled" });

    await processWebhook({
      topic: "orders/create",
      shopDomain: DOMAIN,
      payload: orderPayload(9600002, "42.00") as never,
      accessToken: null,
    });

    const row = await prisma.response.findFirstOrThrow({ where: { shopId } });
    expect(row.orderTotal?.toString()).toBe("42");
    expect(row.verified).toBe(true);

    responses = await fetchSurveyResponses({ shopId, surveyId });
    expect(decideSurveyRevenue(responses[0]!)).toEqual({ included: true, minor: 4200 });
  });

  it("marks a never-arriving order as unverifiedFailed and excludes it", async () => {
    await answer(shopId, "9600003");
    const marked = await markUnverifiedFailedResponses(24, new Date(Date.now() + 48 * 60 * 60 * 1000));
    expect(marked).toBe(1);
    const responses = await fetchSurveyResponses({ shopId, surveyId });
    expect(responses[0]!.unverifiedFailed).toBe(true);
    expect(decideSurveyRevenue(responses[0]!).included).toBe(false);
  });

  it("does not write a total when the order total is unparseable", async () => {
    await answer(shopId, "9600004");
    // An order cached with no parseable total must not be faked as $0.00.
    await prisma.orderCache.create({
      data: {
        shopId,
        orderId: "9600004",
        currency: "USD",
        totalPrice: null,
        createdAtShop: new Date("2026-10-01T10:00:00Z"),
        updatedAtShop: new Date("2026-10-01T10:00:00Z"),
      },
    });
    const result = await reconcileOrderForResponses({ shopId, orderId: "9600004", currency: "USD", totalPrice: "  " });
    expect(result.reconciled).toBe(0);
    const row = await prisma.response.findFirstOrThrow({ where: { shopId } });
    expect(row.orderTotal).toBeNull();
  });
});

describe("atomic Free-cap claim", () => {
  it("lets exactly `cap` of many simultaneous claims through", async () => {
    const cap = 5;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => claimUsageSlot(shopId, cap)),
    );
    const withinCap = results.filter((r) => r.withinCap).length;
    expect(withinCap).toBe(cap);
  });

  it("matches the plan's real cap and rejects before the read", async () => {
    expect(capOf("free")).toBe(FREE_RESPONSE_CAP);
    expect(capOf("growth")).toBeNull();

    const { periodStart, periodEnd } = currentUtcPeriod();
    await prisma.billingUsage.create({
      data: { shopId, periodStart, periodEnd, responsesCount: FREE_RESPONSE_CAP },
    });
    const claim = await claimUsageSlot(shopId, FREE_RESPONSE_CAP);
    expect(claim.withinCap).toBe(false);
    // The stored count is not bumped past the cap by the refused claim path.
    const usage = await prisma.billingUsage.findUniqueOrThrow({
      where: { shopId_periodStart: { shopId, periodStart } },
    });
    expect(usage.responsesCount).toBe(FREE_RESPONSE_CAP);
  });

  it("evaluateCap agrees with the atomic claim at the boundary", () => {
    expect(evaluateCap("free", FREE_RESPONSE_CAP - 1).shouldFlag).toBe(false);
    expect(evaluateCap("free", FREE_RESPONSE_CAP).shouldFlag).toBe(true);
  });
});

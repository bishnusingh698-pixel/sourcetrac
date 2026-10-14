/**
 * Home's "has any answer" gate, against real Postgres.
 *
 * The single-question extension wrote `SurveyResponse`; the multi-question
 * extension writes only `Response`. A merchant whose answers are all v2 must
 * still leave the setup guide, so the gate has to read both tables. Checking the
 * legacy one alone left such a merchant on the setup guide forever.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { hasAnyResponse } from "~/lib/home.server";
import { submitAnswers } from "~/lib/answers.server";
import { createSurvey } from "~/lib/surveys.server";
import { upsertShop } from "~/lib/shop.server";

const prisma = new PrismaClient();
const DOMAIN = "home-gate-test.myshopify.com";
const GID = "gid://shopify/Shop/9500100";

let shopId = "";
let surveyId = "";
let questionId = "";
let optionId = "";

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: GID, accessToken: null });
  shopId = shop.id;
  const survey = await createSurvey(shopId, {
    name: "Home",
    status: "active",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      { type: "single_choice", text: "How did you hear about us?", required: true, options: [{ label: "Instagram" }, { label: "Google" }] },
    ],
  });
  surveyId = survey.id;
  const row = await prisma.question.findFirstOrThrow({ where: { surveyId }, include: { options: true } });
  questionId = row.id;
  optionId = row.options[0]!.id;
});

describe("home has-any-answer gate", () => {
  it("is false for a shop with no answers", async () => {
    expect(await hasAnyResponse(shopId)).toBe(false);
  });

  it("is true when only a v2 Response exists", async () => {
    await submitAnswers({
      shopId,
      surveyId,
      surveyVersion: 1,
      orderId: "9700001",
      placement: "thank_you",
      locale: null,
      answers: [{ questionId, optionIds: [optionId] }],
      plan: "growth",
      definition: {
        questions: [{ id: questionId, type: "single_choice", text: "Q", options: [{ id: optionId, label: "Instagram" }] }],
      },
    });
    // Only the v2 table was written; the legacy table is empty.
    expect(await prisma.surveyResponse.count({ where: { shopId } })).toBe(0);
    expect(await prisma.response.count({ where: { shopId } })).toBe(1);
    expect(await hasAnyResponse(shopId)).toBe(true);
  });
});

/**
 * Learn & stop ("Pause when results are reliable") against Postgres.
 *
 * It paused the survey on every answer that found the results reliable, so a
 * merchant who turned an auto-paused survey back on had it paused again by the
 * very next answer: it could never run again without switching the feature
 * off. It now fires once, records when, and the editor says why.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache, createSurvey, getEditorSurvey, setSurveyStatus } from "~/lib/surveys.server";
import { submitAnswers } from "~/lib/answers.server";

const prisma = new PrismaClient();
const DOMAIN = "learn-stop-test.myshopify.com";
let shopId = "";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9810001", accessToken: null });
  shopId = shop.id;
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
  clearConfigCache();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("learn & stop", () => {
  it("pauses once when reliable, and stays on after the merchant resumes", async () => {
    const survey = await createSurvey(shopId, {
      name: "Channels",
      status: "active",
      placements: ["thank_you"],
      layout: "all",
      title: "Quick question",
      intro: null,
      buttonLabel: "Submit",
      thankYouText: "Thanks",
      learnAndStop: true,
      questions: [
        {
          type: "single_choice",
          text: "How did you hear about us?",
          required: true,
          randomizeOptions: false,
          allowOther: false,
          options: [{ label: "Instagram" }, { label: "Google" }],
        },
      ],
    });
    const question = survey.questions[0]!;
    const instagram = question.options[0]!.id;
    const definition = { questions: [{ ...question, options: question.options.map((o) => ({ id: o.id, label: o.label })) }] };
    const answer = (orderId: string) =>
      submitAnswers({
        shopId,
        surveyId: survey.id,
        surveyVersion: survey.version,
        orderId,
        placement: "thank_you",
        locale: null,
        answers: [{ questionId: question.id, optionIds: [instagram] }],
        plan: "scale",
        definition,
        learnAndStop: true,
        mainQuestionId: question.id,
      } as Parameters<typeof submitAnswers>[0]);

    // Every answer the same: reliable as soon as the 100-answer floor is met.
    for (let i = 0; i < 100; i += 1) await answer(String(8_100_000_000 + i));
    const paused = await getEditorSurvey(shopId, survey.id);
    expect(paused.status).toBe("paused");
    expect(paused.autoPausedAt).not.toBeNull();
    expect(paused.pausedAutomatically).toBe(true);

    await setSurveyStatus(shopId, survey.id, "active");
    const resumed = await getEditorSurvey(shopId, survey.id);
    expect(resumed.pausedAutomatically).toBe(false);
    await answer("8100000999");
    expect((await getEditorSurvey(shopId, survey.id)).status).toBe("active");
  });
});

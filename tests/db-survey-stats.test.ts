/**
 * Per-survey statistics and the survey CSV files, against real Postgres, through
 * the production functions the Results and Export pages call.
 *
 * Pins what a merchant reads first: answers, answer rate, revenue, AOV, the
 * first-order / returning split, per-answer AOV, and that the Export page can
 * download every survey or exactly one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { submitAnswers } from "~/lib/answers.server";
import { ALL_SURVEYS_HEADERS, tableToCsv } from "~/lib/csv";
import { createTranslator } from "~/lib/i18n";
import { upsertShop } from "~/lib/shop.server";
import { createSurvey, type SurveyInput } from "~/lib/surveys.server";
import {
  answerRatePercent,
  aovMinor,
  buildBreakdowns,
  fetchSurveyResponses,
  summariseSurvey,
  surveyAnswerRates,
} from "~/lib/survey-analytics.server";
import {
  buildAllSurveysExport,
  buildSurveyExport,
  countSurveyResponses,
  parseExportSelection,
} from "~/lib/survey-export.server";

const prisma = new PrismaClient();
const DOMAIN = "survey-stats-test.myshopify.com";
const t = createTranslator("en");

let shopId = "";
let channelSurvey = { id: "", questionId: "", instagram: "", google: "", createdAt: new Date() };
let deliverySurvey = { id: "", questionId: "", createdAt: new Date() };

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

async function order(orderId: string, total: string, over: { isTest?: boolean; createdAt?: Date } = {}) {
  const createdAt = over.createdAt ?? new Date();
  await prisma.orderCache.create({
    data: {
      shopId,
      orderId,
      currency: "USD",
      totalPrice: total,
      financialStatus: "paid",
      isTest: over.isTest ?? false,
      isCancelled: false,
      createdAtShop: createdAt,
      updatedAtShop: createdAt,
    },
  });
}

async function answerChannel(orderId: string, optionId: string, isFirstOrder: boolean | null) {
  await submitAnswers({
    shopId,
    surveyId: channelSurvey.id,
    surveyVersion: 1,
    orderId,
    placement: "thank_you",
    locale: null,
    isFirstOrder,
    answers: [{ questionId: channelSurvey.questionId, optionIds: [optionId] }],
    plan: "scale",
    definition: {
      questions: [
        {
          id: channelSurvey.questionId,
          type: "single_choice",
          text: "Where did you find us?",
          options: [
            { id: channelSurvey.instagram, label: "Instagram" },
            { id: channelSurvey.google, label: "Google" },
          ],
        },
      ],
    },
  } as Parameters<typeof submitAnswers>[0]);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9800001", accessToken: null });
  shopId = shop.id;
  // Two live surveys need a paid plan.
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });

  // Placed before either survey existed: never in an answer rate.
  await order("9810000000099", "999.00", { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) });

  const channel = await createSurvey(
    shopId,
    input("Channels", {
      type: "single_choice",
      text: "Where did you find us?",
      required: true,
      options: [{ label: "Instagram" }, { label: "Google" }],
    }),
  );
  const delivery = await createSurvey(
    shopId,
    input("Delivery", { type: "yes_no", text: "Did it arrive on time?", required: true }),
  );
  const channelRow = await prisma.survey.findUniqueOrThrow({ where: { id: channel.id } });
  const deliveryRow = await prisma.survey.findUniqueOrThrow({ where: { id: delivery.id } });
  channelSurvey = {
    id: channel.id,
    questionId: channel.questions[0]!.id,
    instagram: channel.questions[0]!.options[0]!.id,
    google: channel.questions[0]!.options[1]!.id,
    createdAt: channelRow.createdAt,
  };
  deliverySurvey = { id: delivery.id, questionId: delivery.questions[0]!.id, createdAt: deliveryRow.createdAt };

  await order("9810000000001", "40.00");
  await order("9810000000002", "60.00");
  await order("9810000000003", "100.00");
  await order("9810000000004", "500.00", { isTest: true });
  await order("9810000000005", "25.00"); // nobody answered
  await order("9810000000006", "50.00");

  await answerChannel("9810000000001", channelSurvey.instagram, true);
  await answerChannel("9810000000002", channelSurvey.instagram, false);
  await answerChannel("9810000000003", channelSurvey.google, true);
  await answerChannel("9810000000004", channelSurvey.google, null);

  await submitAnswers({
    shopId,
    surveyId: deliverySurvey.id,
    surveyVersion: 1,
    orderId: "9810000000006",
    placement: "thank_you",
    locale: null,
    answers: [{ questionId: deliverySurvey.questionId, numberValue: 1 }],
    plan: "scale",
    definition: {
      questions: [{ id: deliverySurvey.questionId, type: "yes_no", text: "Did it arrive on time?", options: [] }],
    },
  } as Parameters<typeof submitAnswers>[0]);
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("a survey's headline numbers", () => {
  it("counts revenue and AOV from real orders only, and splits first-time from returning buyers", async () => {
    const responses = await fetchSurveyResponses({ shopId, surveyId: channelSurvey.id });
    const summary = summariseSurvey(responses);

    expect(summary.totalResponses).toBe(4);
    // The test order is answered but never counted as revenue.
    expect(summary.revenueByCurrency).toEqual([{ currency: "USD", minor: 20000, orders: 3 }]);
    expect(aovMinor(summary.revenueByCurrency[0]!)).toBe(6667);

    expect(summary.buyers.first).toEqual({
      responses: 2,
      revenueByCurrency: [{ currency: "USD", minor: 14000, orders: 2 }],
    });
    expect(summary.buyers.returning).toEqual({
      responses: 1,
      revenueByCurrency: [{ currency: "USD", minor: 6000, orders: 1 }],
    });
    expect(summary.buyers.unknown).toBe(1);
  });

  it("gives each answer its own revenue and AOV", async () => {
    const responses = await fetchSurveyResponses({ shopId, surveyId: channelSurvey.id });
    const [breakdown] = buildBreakdowns({
      responses,
      questions: [
        {
          id: channelSurvey.questionId,
          type: "single_choice",
          options: [
            { id: channelSurvey.instagram, archived: false },
            { id: channelSurvey.google, archived: false },
          ],
        },
      ],
    });
    expect(breakdown?.kind).toBe("choice");
    if (breakdown?.kind !== "choice") return;
    const instagram = breakdown.options.find((o) => o.optionId === channelSurvey.instagram)!;
    expect(instagram.count).toBe(2);
    expect(instagram.revenueByCurrency).toEqual([{ currency: "USD", minor: 10000, orders: 2 }]);
    expect(aovMinor(instagram.revenueByCurrency[0]!)).toBe(5000);
  });

  it("rates answers against real orders placed while each survey existed", async () => {
    const rates = await surveyAnswerRates({
      shopId,
      surveys: [channelSurvey, deliverySurvey],
      start: null,
      end: new Date(Date.now() + 1000),
    });
    // Five real orders since the surveys were created (the test order and the
    // order placed before them are left out); three answered the channel survey.
    expect(rates.get(channelSurvey.id)).toEqual({ orders: 5, answered: 3 });
    expect(answerRatePercent(rates.get(channelSurvey.id))).toBe(60);
    expect(rates.get(deliverySurvey.id)).toEqual({ orders: 5, answered: 1 });
    expect(answerRatePercent(rates.get(deliverySurvey.id))).toBe(20);
  });

  it("has no answer rate without orders, rather than 0%", () => {
    expect(answerRatePercent({ orders: 0, answered: 0 })).toBeNull();
    expect(answerRatePercent(undefined)).toBeNull();
    expect(answerRatePercent({ orders: 2, answered: 5 })).toBe(100);
  });
});

describe("the survey CSV files", () => {
  const base = () => ({ shopId, shopDomain: DOMAIN, timeZone: "UTC", t });

  it("downloads every survey in one file, one row per answer", async () => {
    const file = await buildAllSurveysExport(base());
    expect(file.headers).toEqual([...ALL_SURVEYS_HEADERS]);
    expect(file.rows).toHaveLength(5);
    expect(file.truncated).toBe(false);

    const survey = file.headers.indexOf("survey");
    const question = file.headers.indexOf("question");
    const answer = file.headers.indexOf("answer");
    const delivery = file.rows.find((row) => row[survey] === "Delivery")!;
    expect(delivery[question]).toBe("Did it arrive on time?");
    expect(delivery[answer]).toBe("Yes");
    expect(new Set(file.rows.map((row) => row[survey]))).toEqual(new Set(["Channels", "Delivery"]));
    expect(await countSurveyResponses(shopId)).toBe(5);
  });

  it("downloads exactly one survey, one row per buyer", async () => {
    const file = await buildSurveyExport({ ...base(), surveyId: channelSurvey.id });
    expect(file.headers.at(-1)).toBe("Where did you find us?");
    expect(file.rows).toHaveLength(4);
    expect(file.rows.map((row) => row.at(-1)).sort()).toEqual(["Google", "Google", "Instagram", "Instagram"]);
    expect(await countSurveyResponses(shopId, channelSurvey.id)).toBe(4);
    expect(tableToCsv(file).startsWith("﻿order,submitted_at")).toBe(true);
  });

  it("previews the newest answers first, with the same values as the file", async () => {
    const file = await buildAllSurveysExport(base());
    const preview = await buildAllSurveysExport({ ...base(), limit: 2, order: "newest_first" });
    expect(preview.truncated).toBe(true);
    expect(preview.rows).toEqual(file.rows.slice(-2).reverse());
  });

  it("chooses every survey for an unknown or foreign survey id", () => {
    const surveys = [{ id: channelSurvey.id }, { id: deliverySurvey.id }];
    expect(parseExportSelection(null, surveys)).toEqual({ kind: "all" });
    expect(parseExportSelection("all", surveys)).toEqual({ kind: "all" });
    expect(parseExportSelection("channels", surveys)).toEqual({ kind: "channels" });
    expect(parseExportSelection(deliverySurvey.id, surveys)).toEqual({ kind: "survey", surveyId: deliverySurvey.id });
    expect(parseExportSelection("someone-elses-survey", surveys)).toEqual({ kind: "all" });
  });
});

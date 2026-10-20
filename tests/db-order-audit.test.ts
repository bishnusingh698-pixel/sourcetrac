/**
 * The 24-hour "order never arrived" sweep, against real Postgres (L26, L27).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { markUnverifiedFailedResponses } from "~/lib/answers.server";
import { createSurvey } from "~/lib/surveys.server";
import { upsertShop } from "~/lib/shop.server";

const prisma = new PrismaClient();
const DOMAIN = "order-audit-test.myshopify.com";
let shopId = "";
let surveyId = "";
const OLD = new Date(Date.now() - 48 * 3600_000);

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9830101" })).id;
  surveyId = (
    await createSurvey(shopId, {
      name: "S", status: "active", placements: ["thank_you"], layout: "all", title: "Q", intro: null,
      buttonLabel: "Submit", thankYouText: "Thanks!",
      questions: [{ type: "single_choice", text: "Where?", options: [{ label: "A" }, { label: "B" }] }],
    })
  ).id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

const answer = (orderId: string, verified: boolean | null) =>
  prisma.response.create({
    data: { shopId, surveyId, surveyVersion: 1, orderId, placement: "thank_you", verified, createdAt: OLD },
  });

describe("order write-off sweep", () => {
  it("writes off a migrated answer (verified NULL) whose order never came (L27)", async () => {
    const row = await answer("983001", null);
    await markUnverifiedFailedResponses();
    expect((await prisma.response.findUniqueOrThrow({ where: { id: row.id } })).unverifiedFailed).toBe(true);
  });

  it("never writes off an answer whose order arrived with an unreadable total (L26)", async () => {
    const row = await answer("983002", false);
    await prisma.orderCache.create({
      data: { shopId, orderId: "983002", currency: "USD", totalPrice: null, createdAtShop: OLD, updatedAtShop: OLD },
    });
    await markUnverifiedFailedResponses();
    expect((await prisma.response.findUniqueOrThrow({ where: { id: row.id } })).unverifiedFailed).toBe(false);
  });
});

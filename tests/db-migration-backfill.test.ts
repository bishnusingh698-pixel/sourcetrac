/**
 * Phase 2 migration backfill, against a real Postgres.
 *
 * The migration converts the old single-question shape (Shop.questionText +
 * optionsJson, SurveyResponse) into Survey / Question / Option / Response /
 * Answer / SurveyDailyStats. This test seeds an old-style survey with 8 options
 * and 25 responses, then runs the migration's real backfill block — read from
 * the migration file, not re-implemented — and asserts the new rows match the
 * old data exactly.
 *
 * Driving the migration SQL itself matters: an earlier test that asserted
 * against a hand-copied query would pass while the migration was broken.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SHOP_ID = "gid://shopify/Shop/3000001";
const SHOP_DOMAIN = "backfill.myshopify.com";
// A second shop seeded with the same default options: production always has
// several, and a shared channel value used to abort the block on the primary key.
const SECOND_SHOP_ID = "gid://shopify/Shop/3000002";

/** The 8-option survey the brief describes as the old shape. */
const OLD_OPTIONS = [
  { value: "google", label: "Google search", emoji: null },
  { value: "instagram", label: "Instagram", emoji: null },
  { value: "facebook", label: "Facebook", emoji: null },
  { value: "tiktok", label: "TikTok", emoji: null },
  { value: "friend-or-family", label: "Friend or family", emoji: null },
  { value: "podcast", label: "Podcast", emoji: null },
  { value: "email", label: "Email", emoji: null },
  { value: "other", label: "Other", emoji: null },
];

const RESPONSE_COUNT = 25;

/** Extract the `DO $backfill$ … $backfill$;` block from the migration file. */
function backfillSql(): string {
  const dir = join(import.meta.dirname, "..", "prisma", "migrations");
  const files = readFileSync(join(dir, "migration_lock.toml"), "utf8");
  expect(files).toContain("postgresql");

  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const migration = readdirSync(dir).find((name) => name.endsWith("_multi_question_survey"));
  if (!migration) throw new Error("multi_question_survey migration not found");
  const sql = readFileSync(join(dir, migration, "migration.sql"), "utf8");
  const match = /DO\s+\$backfill\$[\s\S]*?\$backfill\$;/m.exec(sql);
  if (!match) throw new Error("backfill block not found in migration");
  return match[0];
}

async function reset() {
  // Clear any previously backfilled rows first. The migration's backfill loops
  // over EVERY shop, so a leftover bf-* survey from an earlier run (this test
  // or another) would collide on the deterministic id. Deleting the Survey row
  // cascades to its questions, options, responses, answers and daily stats.
  await prisma.survey.deleteMany({ where: { id: { startsWith: "bf-survey-" } } });

  // New-model rows key on the shop's internal cuid, not the Shopify GID, so
  // resolve the row first. Order matters: children before parents.
  const shop = await prisma.shop.findUnique({ where: { shopId: SHOP_ID }, select: { id: true } });
  await prisma.surveyResponse.deleteMany({ where: { shopId: shop?.id ?? "__none__" } });
  await prisma.orderCache.deleteMany({ where: { shopId: shop?.id ?? "__none__" } });
  await prisma.shop.deleteMany({ where: { shopId: { in: [SHOP_ID, SECOND_SHOP_ID] } } });
}

/** The shop's internal cuid, which the new models reference (not the GID). */
async function internalShopId(): Promise<string> {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { shopId: SHOP_ID }, select: { id: true } });
  return shop.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
  await reset();

  const shop = await prisma.shop.create({
    data: {
      shopId: SHOP_ID,
      shopDomain: SHOP_DOMAIN,
      installState: "installed",
      questionText: "How did you hear about us?",
      optionsJson: JSON.stringify(OLD_OPTIONS),
      allowOther: true,
    },
  });

  await prisma.shop.create({
    data: {
      shopId: SECOND_SHOP_ID,
      shopDomain: "backfill-second.myshopify.com",
      installState: "installed",
      questionText: "How did you hear about us?",
      optionsJson: JSON.stringify(OLD_OPTIONS),
    },
  });

  // 25 answers spread across the 8 options. Every third one is reconciled to a
  // cached, countable order so the totals table has some revenue to backfill.
  for (let i = 0; i < RESPONSE_COUNT; i += 1) {
    const option = OLD_OPTIONS[i % OLD_OPTIONS.length]!;
    const orderId = String(800000 + i);
    const reconciled = i % 3 === 0;

    await prisma.surveyResponse.create({
      data: {
        shopId: shop.id,
        orderId,
        channel: option.value,
        otherText: option.value === "other" ? "A friend told me" : null,
        orderTotal: reconciled ? "42.500" : null,
        currency: reconciled ? "USD" : null,
        reconciled,
        submittedAt: new Date(Date.UTC(2026, 8, 1 + (i % 10), 12, 0, 0)),
      },
    });

    if (reconciled) {
      await prisma.orderCache.create({
        data: {
          shopId: shop.id,
          orderId,
          currency: "USD",
          totalPrice: "42.500",
          financialStatus: "paid",
          isTest: false,
          isCancelled: false,
          createdAtShop: new Date(Date.UTC(2026, 8, 1 + (i % 10), 11, 0, 0)),
          updatedAtShop: new Date(Date.UTC(2026, 8, 1 + (i % 10), 11, 0, 0)),
        },
      });
    }
  }

  // Run the real migration backfill.
  await prisma.$executeRawUnsafe(backfillSql());
}, 60_000);

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("migration backfill", () => {
  it("creates one active single-choice survey with the 8 options preserved", async () => {
    const shopId = await internalShopId();
    const survey = await prisma.survey.findUnique({
      where: { id: `bf-survey-${shopId}` },
      include: { questions: { include: { options: { orderBy: { position: "asc" } } } } },
    });

    expect(survey).not.toBeNull();
    expect(survey?.status).toBe("active");
    expect(survey?.questions).toHaveLength(1);
    expect(survey?.questions[0]?.type).toBe("single_choice");
    expect(survey?.questions[0]?.allowOther).toBe(true);

    const options = survey?.questions[0]?.options ?? [];
    expect(options).toHaveLength(8);
    // Option ids are shop-scoped: the primary key spans every shop.
    expect(options.map((o) => o.id)).toEqual(OLD_OPTIONS.map((o) => `bf-option-${shopId}-${o.value}`));
    expect(options.map((o) => o.label)).toEqual(OLD_OPTIONS.map((o) => o.label));
  });

  it("backfills a second shop that shares the same option values", async () => {
    const second = await prisma.shop.findUniqueOrThrow({ where: { shopId: SECOND_SHOP_ID } });
    const options = await prisma.option.findMany({ where: { question: { survey: { shopId: second.id } } } });
    expect(options).toHaveLength(OLD_OPTIONS.length);
  });

  it("converts every old response into a Response + Answer, keeping the order id", async () => {
    const shopId = await internalShopId();
    const responses = await prisma.response.findMany({
      where: { shopId },
      include: { answers: true },
    });
    expect(responses).toHaveLength(RESPONSE_COUNT);
    expect(responses.every((r) => r.answers.length === 1)).toBe(true);

    const old = await prisma.surveyResponse.findMany({ where: { shopId: await internalShopId() } });
    const oldOrderIds = new Set(old.map((r) => r.orderId));
    const newOrderIds = new Set(responses.map((r) => r.orderId));
    expect(newOrderIds).toEqual(oldOrderIds);
  });

  it("keeps identical counts per option", async () => {
    const shopId = await internalShopId();
    const oldCounts = new Map<string, number>();
    for (const row of await prisma.surveyResponse.findMany({ where: { shopId: await internalShopId() } })) {
      const id = `bf-option-${shopId}-${row.channel}`;
      oldCounts.set(id, (oldCounts.get(id) ?? 0) + 1);
    }

    const answers = await prisma.answer.findMany({ where: { shopId } });
    const newCounts = new Map<string, number>();
    for (const answer of answers) {
      const ids = JSON.parse(answer.optionIds) as string[];
      const id = ids[0]!;
      newCounts.set(id, (newCounts.get(id) ?? 0) + 1);
    }

    expect(newCounts).toEqual(oldCounts);
  });

  it("backfills SurveyDailyStats so the response count matches", async () => {
    const shopId = await internalShopId();
    const totals = await prisma.surveyDailyStats.findMany({
      where: { shopId, bucket: "_responses" },
    });
    const total = totals.reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(RESPONSE_COUNT);
  });

  it("sets the survey response count from the old rows", async () => {
    const shopId = await internalShopId();
    const survey = await prisma.survey.findUnique({ where: { id: `bf-survey-${shopId}` } });
    expect(survey?.responseCount).toBe(RESPONSE_COUNT);
  });
});

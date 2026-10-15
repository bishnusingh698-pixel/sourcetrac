/**
 * Order webhooks and the backfill, against real Postgres (ORD flow): v2
 * answers are backfilled and reconciled, a failed reconcile is retried rather
 * than acknowledged, same-second updates apply in delivery order, and the
 * ledger re-claim is atomic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { markUnverifiedFailedResponses } from "~/lib/answers.server";
import { backfillMissingOrders, resetBackfillAttempts } from "~/lib/order-backfill.server";
import { claimWebhook, markWebhookFailed, upsertOrderCache } from "~/lib/webhooks.server";

const prisma = new PrismaClient();
const DOMAIN = "order-flow-test.myshopify.com";
const NOW = new Date("2026-10-11T12:00:00Z");
let shopId = "";
let surveyId = "";

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  resetBackfillAttempts();
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "of-" } } });
  const shop = await prisma.shop.create({ data: { shopId: "gid://shopify/Shop/930000", shopDomain: DOMAIN, installState: "installed" } });
  shopId = shop.id;
  const survey = await prisma.survey.create({ data: { shopId, name: "S", placements: '["thank_you"]' } });
  surveyId = survey.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

const payload = (over: Record<string, unknown> = {}) =>
  ({
    id: 930001,
    currency: "USD",
    current_total_price: "40.00",
    financial_status: "paid",
    test: false,
    cancelled_at: null,
    created_at: "2026-10-01T09:00:00Z",
    updated_at: "2026-10-01T09:00:00Z",
    ...over,
  }) as never;

describe("order flow", () => {
  it("backfills the order behind a v2 answer and fills its total (H4)", async () => {
    await prisma.response.create({
      data: { shopId, surveyId, surveyVersion: 1, orderId: "930001", placement: "thank_you", createdAt: new Date("2026-10-11T11:00:00Z") },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              order: {
                legacyResourceId: "930001", name: "#1", test: false, cancelledAt: null,
                createdAt: "2026-10-01T09:00:00Z", updatedAt: "2026-10-01T09:00:00Z", displayFinancialStatus: "PAID",
                currentTotalPriceSet: { shopMoney: { amount: "40.00", currencyCode: "USD" } },
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    expect(await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "t", now: NOW })).toBe(1);
    const row = await prisma.response.findFirstOrThrow({ where: { shopId } });
    expect(row.orderTotal?.toString()).toBe("40");
  });

  it("throws when the v2 reconcile fails, so Shopify retries (H3)", async () => {
    // A real database failure on the v2 table only, via a statement trigger.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION of_fail_response_update() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'reconcile boom'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER of_fail BEFORE UPDATE ON "Response" FOR EACH STATEMENT EXECUTE FUNCTION of_fail_response_update()`,
    );
    try {
      await expect(upsertOrderCache(shopId, payload(), false)).rejects.toThrow(/reconcile boom/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS of_fail ON "Response"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS of_fail_response_update()`);
    }
  });

  it("applies two same-second updates in delivery order (L21)", async () => {
    const t1 = new Date("2026-10-01T09:00:00.100Z");
    const t2 = new Date("2026-10-01T09:00:00.900Z");
    // The later delivery (a cancellation) lands first; the earlier one must not undo it.
    await upsertOrderCache(shopId, payload({ cancelled_at: "2026-10-01T09:00:00Z", financial_status: "voided" }), true, t2);
    const stale = await upsertOrderCache(shopId, payload({ financial_status: "paid" }), false, t1);
    expect(stale?.applied).toBe(false);
    const row = await prisma.orderCache.findFirstOrThrow({ where: { shopId } });
    expect(row.financialStatus).toBe("voided");
  });

  it("lets only one of two concurrent retries re-claim a failed delivery (L19)", async () => {
    await claimWebhook({ webhookId: "of-1", topic: "orders/create", apiVersion: null });
    await markWebhookFailed("of-1", "boom");
    const results = await Promise.all([
      claimWebhook({ webhookId: "of-1", topic: "orders/create", apiVersion: null }),
      claimWebhook({ webhookId: "of-1", topic: "orders/create", apiVersion: null }),
    ]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it("never writes off an order-less answer and recovers a cached order first (I2)", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await prisma.response.create({ data: { shopId, surveyId, surveyVersion: 1, orderId: null, placement: "link", createdAt: old } });
    await prisma.response.create({ data: { shopId, surveyId, surveyVersion: 1, orderId: "930002", placement: "thank_you", createdAt: old } });
    await prisma.orderCache.create({
      data: {
        shopId, orderId: "930002", currency: "USD", totalPrice: "12.00", financialStatus: "paid",
        isTest: false, isCancelled: false, createdAtShop: old, updatedAtShop: old,
      },
    });
    await markUnverifiedFailedResponses(24);
    const rows = await prisma.response.findMany({ where: { shopId }, orderBy: { orderId: "asc" } });
    expect(rows.every((r) => !r.unverifiedFailed)).toBe(true);
    expect(rows.find((r) => r.orderId === "930002")?.orderTotal?.toString()).toBe("12");
  });
});

/**
 * Orders the webhooks never delivered are fetched from the Admin API and run
 * through the same `upsertOrderCache` as a webhook. Real Postgres; only the
 * network call to Shopify is stubbed, at `fetch`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";

import { fetchResponsesInWindow, toDecidedAmounts } from "~/lib/analytics-queries.server";
import { backfillMissingOrders, orderNodeToPayload, resetBackfillAttempts } from "~/lib/order-backfill.server";

const prisma = new PrismaClient();
const DOMAIN = "backfill-test.myshopify.com";
const NOW = new Date("2026-10-11T12:00:00Z");

let shopId = "";

const orderNode = (overrides: Record<string, unknown> = {}) => ({
  legacyResourceId: "920001",
  name: "#1042",
  test: true,
  cancelledAt: null,
  createdAt: "2026-10-01T09:00:00Z",
  updatedAt: "2026-10-01T09:00:00Z",
  displayFinancialStatus: "PAID",
  currentTotalPriceSet: { shopMoney: { amount: "48.5", currencyCode: "USD" } },
  ...overrides,
});

function stubShopify(order: unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body).variables.id);
      return new Response(JSON.stringify({ data: { order } }), { status: 200 });
    }),
  );
  return calls;
}

async function cleanup() {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
}

beforeAll(async () => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) {
    throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
  }
});

beforeEach(async () => {
  await cleanup();
  resetBackfillAttempts();
  const shop = await prisma.shop.create({
    data: { shopId: "gid://shopify/Shop/920000", shopDomain: DOMAIN, installState: "installed" },
  });
  shopId = shop.id;
  await prisma.surveyResponse.create({
    data: { shopId, orderId: "920001", channel: "instagram", submittedAt: new Date("2026-10-11T11:00:00Z") },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("order backfill", () => {
  it("maps the GraphQL order onto the webhook payload shape", () => {
    expect(orderNodeToPayload(orderNode({ displayFinancialStatus: "PARTIALLY_REFUNDED" }))).toMatchObject({
      id: "920001",
      name: "#1042",
      currency: "USD",
      current_total_price: "48.5",
      financial_status: "partially_refunded",
      test: true,
    });
  });

  it("fetches an order no webhook delivered and reconciles its answer", async () => {
    const calls = stubShopify(orderNode({ test: false }));

    const written = await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "shpat_x", now: NOW });

    expect(written).toBe(1);
    expect(calls).toEqual(["gid://shopify/Order/920001"]);
    const rows = await fetchResponsesInWindow({ shopId });
    expect(rows[0]).toMatchObject({ reconciled: true, order: expect.objectContaining({ orderNumber: "#1042" }) });
    expect(toDecidedAmounts(rows)).toEqual([expect.objectContaining({ minor: 4850, currency: "USD" })]);
  });

  it("does not ask again within the hour for an order Shopify could not return", async () => {
    const calls = stubShopify(null);
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "shpat_x", now: NOW });
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "shpat_x", now: NOW });
    expect(calls).toHaveLength(1);
  });

  it("leaves a just-submitted answer to the webhook", async () => {
    const calls = stubShopify(orderNode());
    const soon = new Date("2026-10-11T11:01:00Z");
    expect(await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "shpat_x", now: soon })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("never throws when Shopify fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await expect(
      backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "shpat_x", now: NOW }),
    ).resolves.toBe(0);
  });
});

describe("order backfill (2026-10-20 audit)", () => {
  it("does not park a batch for a week when the token is refused (L30)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: "Invalid API key or access token" }), { status: 401 })));
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "t", now: NOW });
    // The next run, an hour later with a good token, reads the order again.
    const calls = stubShopify(orderNode());
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "t", now: new Date(NOW.getTime() + 61 * 60_000) });
    expect(calls).toHaveLength(1);
  });

  it("parks an order whose answer cannot be stored instead of asking every hour (L31)", async () => {
    stubShopify(orderNode({ currentTotalPriceSet: null }));
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "t", now: NOW });
    const calls = stubShopify(orderNode());
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "t", now: new Date(NOW.getTime() + 61 * 60_000) });
    expect(calls).toHaveLength(0);
  });

  it("re-reads an order stored with a total it could not read (L26)", async () => {
    await prisma.orderCache.create({
      data: {
        shopId, orderId: "920001", currency: "USD", totalPrice: null,
        createdAtShop: new Date("2026-10-01T09:00:00Z"), updatedAtShop: new Date("2026-10-01T09:00:00Z"),
      },
    });
    const calls = stubShopify(orderNode());
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "t", now: NOW });
    expect(calls).toHaveLength(1);
    const order = await prisma.orderCache.findUniqueOrThrow({ where: { shopId_orderId: { shopId, orderId: "920001" } } });
    expect(order.totalPrice?.toString()).toBe("48.5");
  });

  it("keeps a webhook's delivery time when the backfill rewrites the order (L25)", async () => {
    const triggeredAt = new Date("2026-10-01T09:00:00.500Z");
    await prisma.orderCache.create({
      data: {
        shopId, orderId: "920001", currency: "USD", totalPrice: null, triggeredAt,
        createdAtShop: new Date("2026-10-01T09:00:00Z"), updatedAtShop: new Date("2026-10-01T09:00:00Z"),
      },
    });
    stubShopify(orderNode());
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "t", now: NOW });
    const order = await prisma.orderCache.findUniqueOrThrow({ where: { shopId_orderId: { shopId, orderId: "920001" } } });
    expect(order.triggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
  });

  it("parks an order whose total Shopify still reports unreadably (review)", async () => {
    stubShopify(orderNode({ currentTotalPriceSet: { shopMoney: { amount: "not-a-number", currencyCode: "USD" } } }));
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "t", now: NOW });
    const calls = stubShopify(orderNode());
    await backfillMissingOrders({ shopId, shopDomain: DOMAIN, accessToken: "t", now: new Date(NOW.getTime() + 61 * 60_000) });
    expect(calls).toHaveLength(0);
  });
});

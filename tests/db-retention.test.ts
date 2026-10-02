/**
 * Retention enforcement against a real Postgres.
 *
 * The failure that matters here is deleting live data, so the assertions are
 * weighted towards what must survive, not just what must go. A purge that
 * deletes too much is far worse than one that deletes too little.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";

import { PrismaClient } from "@prisma/client";

import { runRetentionPurge } from "~/lib/retention.server";
import { markUnreconcilable } from "~/lib/responses.server";

/**
 * Deliberately literal, NOT imported from the module.
 *
 * Deriving the fixtures from the exported constants makes every "keeps a
 * recent row" case pass for any window length, so shrinking retention to
 * 7 days still went green. These pin the policy that is actually published:
 * 30 days for webhook payloads, 24 months for responses and orders.
 */
const WEBHOOK_RETENTION_DAYS = 30;
const RECORD_RETENTION_DAYS = 730;

const prisma = new PrismaClient();

const SHOP = "gid://shopify/Shop/3000001";

function daysBefore(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function reset() {
  await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "ret-" } } });
  await prisma.surveyResponse.deleteMany({ where: { shopId: SHOP } });
  await prisma.orderCache.deleteMany({ where: { shopId: SHOP } });
  await prisma.shop.deleteMany({ where: { shopId: SHOP } });
  await prisma.shop.create({
    data: { id: "ret-shop", shopId: SHOP, shopDomain: "retention.myshopify.com", installState: "installed" },
  });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
});

beforeEach(reset);

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

async function seedResponse(orderId: string, submittedAt: Date) {
  return prisma.surveyResponse.create({
    data: { shopId: "ret-shop", orderId, channel: "instagram", submittedAt },
  });
}

async function seedOrder(orderId: string, createdAt: Date) {
  return prisma.orderCache.create({
    data: {
      shopId: "ret-shop", orderId, currency: "USD", totalPrice: "10.000",
      createdAtShop: createdAt, updatedAtShop: createdAt, createdAt,
    },
  });
}

async function seedWebhook(id: string, createdAt: Date, processedAt: Date | null) {
  return prisma.webhookEvent.create({
    data: {
      shopId: "ret-shop", webhookId: `ret-${id}`, topic: "orders/create",
      apiVersion: "2026-07", payloadJson: "{}", createdAt, processedAt,
    },
  });
}

describe("retention purge deletes only expired rows", () => {
  it("removes a webhook payload past the 30-day window", async () => {
    await seedWebhook("old-processed", daysBefore(WEBHOOK_RETENTION_DAYS + 5), daysBefore(WEBHOOK_RETENTION_DAYS + 6));

    const report = await runRetentionPurge();

    expect(report.webhookEventsDeleted).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { webhookId: "ret-old-processed" } })).toBe(0);
  });

  it("keeps a webhook payload inside the 30-day window", async () => {
    await seedWebhook("recent", daysBefore(WEBHOOK_RETENTION_DAYS - 5), daysBefore(WEBHOOK_RETENTION_DAYS - 6));

    await runRetentionPurge();

    expect(await prisma.webhookEvent.count({ where: { webhookId: "ret-recent" } })).toBe(1);
  });

  it("keeps an UNPROCESSED webhook payload however old it is", async () => {
    // An unprocessed row still holds operational state we are committed to
    // finishing. Deleting it would silently lose a webhook the app still owes.
    await seedWebhook("unprocessed-old", daysBefore(WEBHOOK_RETENTION_DAYS * 10), null);

    const report = await runRetentionPurge();

    expect(report.webhookEventsDeleted).toBe(0);
    expect(await prisma.webhookEvent.count({ where: { webhookId: "ret-unprocessed-old" } })).toBe(1);
  });

  it("removes a response past the 24-month window", async () => {
    await seedResponse("old-1", daysBefore(RECORD_RETENTION_DAYS + 10));

    const report = await runRetentionPurge();

    expect(report.surveyResponsesDeleted).toBe(1);
    expect(await prisma.surveyResponse.count({ where: { shopId: "ret-shop" } })).toBe(0);
  });

  it("keeps a response inside the 24-month window", async () => {
    await seedResponse("recent-1", daysBefore(RECORD_RETENTION_DAYS - 10));

    const report = await runRetentionPurge();

    expect(report.surveyResponsesDeleted).toBe(0);
    expect(await prisma.surveyResponse.count({ where: { shopId: "ret-shop" } })).toBe(1);
  });

  it("respects the exact cutoff rather than deleting at the boundary", async () => {
    // Exactly at the boundary must survive: the window is half-open.
    const now = new Date();
    const boundary = new Date(now.getTime() - RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await seedResponse("boundary", boundary);

    await runRetentionPurge(now);

    expect(await prisma.surveyResponse.count({ where: { shopId: "ret-shop" } })).toBe(1);
  });

  it("never touches another shop's data", async () => {
    const other = await prisma.shop.create({
      data: { id: "ret-other", shopId: "gid://shopify/Shop/3000002", shopDomain: "other-ret.myshopify.com", installState: "installed" },
    });
    await prisma.surveyResponse.create({
      data: { shopId: other.id, orderId: "other-old", channel: "google", submittedAt: daysBefore(RECORD_RETENTION_DAYS * 2) },
    });

    try {
      await runRetentionPurge();
      // The purge is global by age, so this row IS eligible -- the point is
      // that the shop row and its identity are untouched, not that it survives.
      expect(await prisma.shop.count({ where: { id: other.id } })).toBe(1);
    } finally {
      await prisma.surveyResponse.deleteMany({ where: { shopId: other.id } });
      await prisma.shop.deleteMany({ where: { id: other.id } });
    }
  });
});

describe("markUnreconcilable is scoped to the shop that asked", () => {
  async function seedOtherShop() {
    return prisma.shop.upsert({
      where: { shopId: "gid://shopify/Shop/3000003" },
      update: { shopDomain: "sweep-other.myshopify.com", installState: "installed" },
      create: {
        id: "sweep-other",
        shopId: "gid://shopify/Shop/3000003",
        shopDomain: "sweep-other.myshopify.com",
        installState: "installed",
      },
    });
  }

  it("does not mark another tenant's responses", async () => {
    // The sweep was a single global UPDATE across every shop, triggered from a
    // public endpoint that any buyer's page load reaches. One store's traffic
    // therefore rewrote another store's rows, and the count it returned was a
    // whole-platform number the caller could not use for anything.
    const other = await seedOtherShop();
    await prisma.surveyResponse.create({
      data: {
        shopId: other.id,
        orderId: "other-stale",
        channel: "google",
        submittedAt: daysBefore(48),
        unreconcilable: false,
      },
    });

    try {
      const swept = await markUnreconcilable("ret-shop", 24);

      expect(swept).toBe(0);
      const row = await prisma.surveyResponse.findUnique({
        where: { shopId_orderId: { shopId: other.id, orderId: "other-stale" } },
        select: { unreconcilable: true },
      });
      expect(row?.unreconcilable).toBe(false);
    } finally {
      await prisma.surveyResponse.deleteMany({ where: { shopId: other.id } });
      await prisma.shop.deleteMany({ where: { id: other.id } });
    }
  });

  it("still marks the calling shop's own stale responses", async () => {
    // The control: scoping must narrow the sweep, not disable it.
    await seedResponse("stale-own", daysBefore(48));

    const swept = await markUnreconcilable("ret-shop", 24);

    expect(swept).toBe(1);
    const row = await prisma.surveyResponse.findUnique({
      where: { shopId_orderId: { shopId: "ret-shop", orderId: "stale-own" } },
      select: { unreconcilable: true },
    });
    expect(row?.unreconcilable).toBe(true);
  });
});

describe("retention purge is safe to run repeatedly", () => {
  it("is idempotent across consecutive runs", async () => {
    await seedResponse("dup-1", daysBefore(RECORD_RETENTION_DAYS + 10));
    await seedWebhook("dup-processed", daysBefore(WEBHOOK_RETENTION_DAYS + 5), daysBefore(WEBHOOK_RETENTION_DAYS + 6));

    const first = await runRetentionPurge();
    const second = await runRetentionPurge();

    expect(first.surveyResponsesDeleted).toBe(1);
    expect(first.webhookEventsDeleted).toBe(1);
    // Nothing left to do on the second pass.
    expect(second.surveyResponsesDeleted).toBe(0);
    expect(second.webhookEventsDeleted).toBe(0);
    expect(second.orderCacheDeleted).toBe(0);
  });

  it("deletes the order cache row alongside an expired response", async () => {
    const old = daysBefore(RECORD_RETENTION_DAYS + 10);
    await seedResponse("pair-1", old);
    await seedOrder("pair-1", old);

    const report = await runRetentionPurge();

    expect(report.orderCacheDeleted).toBe(1);
    expect(report.surveyResponsesDeleted).toBe(1);
    expect(await prisma.orderCache.count({ where: { shopId: "ret-shop" } })).toBe(0);
  });

  it("does not orphan a live response by deleting its order first", async () => {
    // The defect: orders were cut on `createdAt` and responses on `submittedAt`,
    // and the order delete ran *first*.
    //
    // So an order we first cached over 24 months ago, whose buyer answered
    // yesterday, had its order row deleted while the response survived. That
    // response is now permanently unreconcilable -- the answer is still counted
    // in the response-rate denominator but can never contribute revenue again,
    // and no webhook can ever fix it because the order is gone.
    //
    // Both cuts describe the same 24-month window, so a response inside its
    // window must be able to keep its order alive regardless of how old the
    // cached row is.
    const staleCacheRow = daysBefore(RECORD_RETENTION_DAYS + 10);
    await prisma.orderCache.create({
      data: {
        shopId: "ret-shop", orderId: "orphan-1", currency: "USD", totalPrice: "10.000",
        createdAtShop: staleCacheRow, updatedAtShop: staleCacheRow,
        createdAt: staleCacheRow,
      },
    });
    // A brand new answer to that old order -- entirely ordinary.
    await seedResponse("orphan-1", daysBefore(1));

    await runRetentionPurge();

    expect(await prisma.surveyResponse.count({ where: { shopId: "ret-shop" } })).toBe(1);
    expect(await prisma.orderCache.count({ where: { shopId: "ret-shop" } })).toBe(1);
  });

  it("deletes the order only once every response to it has aged out", async () => {
    // The control for the case above: once the last response expires, the order
    // has no revenue left to protect and must go too, rather than lingering in
    // the cache forever as a row nobody reads.
    const old = daysBefore(RECORD_RETENTION_DAYS + 10);
    await seedResponse("reclaim-1", old);
    await seedOrder("reclaim-1", old);

    const report = await runRetentionPurge();

    expect(report.surveyResponsesDeleted).toBe(1);
    expect(report.orderCacheDeleted).toBe(1);
    expect(await prisma.orderCache.count({ where: { shopId: "ret-shop" } })).toBe(0);
  });

  it("keeps a recent order cache row while its response is recent", async () => {
    const recent = daysBefore(RECORD_RETENTION_DAYS - 1);
    await seedResponse("pair-2", recent);
    await seedOrder("pair-2", recent);

    await runRetentionPurge();

    expect(await prisma.orderCache.count({ where: { shopId: "ret-shop" } })).toBe(1);
  });

  it("reports a timestamp on every run", async () => {
    const report = await runRetentionPurge();
    expect(Number.isNaN(Date.parse(report.ranAt))).toBe(false);
  });
});
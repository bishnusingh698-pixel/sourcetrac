/**
 * Database invariant checks.
 *
 * These run against a real Postgres, not a mock: the whole point is to prove
 * the uniqueness guarantees that duplicate-submission and webhook-retry safety
 * depend on actually hold at the storage layer. Prisma expresses `@@unique` as
 * a unique *index* rather than a constraint, so asserting here catches a
 * regression that a schema read-through would miss.
 *
 * Run with: npm run test:db
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";

import { PrismaClient } from "@prisma/client";

import { fetchResponsesInWindow } from "~/lib/analytics-queries.server";
import { processWebhook } from "~/lib/webhooks.server";

import { isSupportedLanguage } from "~/lib/i18n";

const prisma = new PrismaClient();

const SHOP_ID = "gid://shopify/Shop/1000001";

async function reset() {
  await prisma.surveyResponse.deleteMany({ where: { shopId: { in: [SHOP_ID, OTHER_SHOP_ID] } } });
  await prisma.orderCache.deleteMany({ where: { shopId: { in: [SHOP_ID, OTHER_SHOP_ID] } } });
  await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "wh-" } } });
  await prisma.shop.deleteMany({ where: { shopId: { in: [SHOP_ID, OTHER_SHOP_ID] } } });
}

const OTHER_SHOP_ID = "gid://shopify/Shop/1000002";

/**
 * Upsert rather than create: several assertions reuse the same shop GID, and a
 * plain create would trip the shopId unique index on the second run.
 */
async function seedShop(shopId: string, shopDomain: string) {
  return prisma.shop.upsert({
    where: { shopId },
    update: { shopDomain, installState: "installed", accessTokenEncrypted: null },
    create: { shopId, shopDomain, installState: "installed" },
  });
}

beforeAll(async () => {
  // Guard against pointing the suite at a real database.
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
  await reset();
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("unique(shop_id, order_id) on survey_responses", () => {
  it("rejects a second response for the same order in the same shop", async () => {
    const shop = await seedShop(SHOP_ID, "dup-test.myshopify.com");

    await prisma.surveyResponse.create({
      data: { shopId: shop.id, orderId: "5551", channel: "instagram" },
    });

    // The insert must fail so the caller can fall back to a duplicate response.
    await expect(
      prisma.surveyResponse.create({
        data: { shopId: shop.id, orderId: "5551", channel: "google" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows the same order id in a different shop", async () => {
    const a = await seedShop(SHOP_ID, "dup-test.myshopify.com");
    const b = await seedShop(OTHER_SHOP_ID, "dup-other.myshopify.com");

    await prisma.surveyResponse.create({ data: { shopId: a.id, orderId: "777", channel: "a" } });
    await prisma.surveyResponse.create({ data: { shopId: b.id, orderId: "777", channel: "b" } });

    const count = await prisma.surveyResponse.count({ where: { orderId: "777" } });
    expect(count).toBe(2);
  });
});

describe("webhook_events idempotency ledger", () => {
  it("rejects a repeated webhook id", async () => {
    await prisma.webhookEvent.create({
      data: {
        webhookId: "wh-dup-1",
        topic: "orders/create",
        payloadJson: "{}",
      },
    });

    await expect(
      prisma.webhookEvent.create({
        data: {
          webhookId: "wh-dup-1",
          topic: "orders/create",
          payloadJson: "{}",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("order_cache unique(shop_id, order_id)", () => {
  it("rejects caching the same order twice and accepts an update", async () => {
    const shop = await seedShop(SHOP_ID, "dup-test.myshopify.com");

    const now = new Date();
    const base = {
      shopId: shop.id,
      orderId: "888",
      currency: "USD",
      createdAtShop: now,
      updatedAtShop: now,
    };

    await prisma.orderCache.create({ data: { ...base, totalPrice: "100.00" } });

    // Reconcile must be able to update in place, not insert a duplicate row.
    const updated = await prisma.orderCache.update({
      where: { shopId_orderId: { shopId: shop.id, orderId: "888" } },
      data: { totalPrice: "90.00" },
    });
    expect(updated.totalPrice.toString()).toBe("90");

    await expect(
      prisma.orderCache.create({ data: { ...base, totalPrice: "1.00" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("billing_usage unique(shop_id, period_start)", () => {
  it("rejects two usage rows for the same period", async () => {
    const shop = await seedShop(SHOP_ID, "dup-test.myshopify.com");
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    await prisma.billingUsage.create({
      data: { shopId: shop.id, periodStart, periodEnd: new Date("2026-11-01T00:00:00.000Z"), responsesCount: 1 },
    });

    await expect(
      prisma.billingUsage.create({
        data: { shopId: shop.id, periodStart, periodEnd: new Date("2026-11-01T00:00:00.000Z"), responsesCount: 2 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("encrypted access token columns", () => {
  it("stores ciphertext, iv and tag separately and never plaintext", async () => {
    const shop = await seedShop(SHOP_ID, "enc-test.myshopify.com");
    const stored = await prisma.shop.update({
      where: { id: shop.id },
      data: {
        accessTokenEncrypted: Buffer.from("ciphertext-bytes").toString("base64"),
        accessTokenIv: Buffer.from("0123456789abcdef").toString("base64"),
        accessTokenTag: Buffer.from("0123456789abcdef").toString("base64"),
      },
    });

    expect(stored.accessTokenEncrypted).not.toContain("shpat_");
    expect(stored.accessTokenIv).toBeTruthy();
    expect(stored.accessTokenTag).toBeTruthy();

    // Reinstating clears the credential but keeps the row and its history.
    const afterUninstall = await prisma.shop.update({
      where: { id: shop.id },
      data: { installState: "uninstalled", accessTokenEncrypted: null },
    });
    expect(afterUninstall.accessTokenEncrypted).toBeNull();
    expect(afterUninstall.id).toBe(shop.id);
  });
});

describe("shop language", () => {
  /**
   * Written through Prisma rather than `setLanguage` deliberately: importing an
   * app module drags in the env schema, and this suite is about what the column
   * actually accepts. The validation that guards real writes is asserted
   * separately below.
   */
  it("round-trips a language choice and clears back to detection", async () => {
    const shop = await seedShop(SHOP_ID, "lang-test.myshopify.com");

    // A fresh install has made no choice, so the admin must fall back to locale
    // detection rather than inventing one and suppressing the onboarding picker.
    const fresh = await prisma.shop.findUnique({ where: { id: shop.id }, select: { language: true } });
    expect(fresh?.language).toBeNull();

    const chosen = await prisma.shop.update({
      where: { id: shop.id },
      data: { language: "ja" },
      select: { language: true },
    });
    expect(chosen.language).toBe("ja");

    // Clearing restores detection rather than stranding the merchant in a
    // language they can no longer get out of.
    const cleared = await prisma.shop.update({
      where: { id: shop.id },
      data: { language: null },
      select: { language: true },
    });
    expect(cleared.language).toBeNull();
  });

  it("stores an unsupported language verbatim, so validation must live above the DB", async () => {
    const shop = await seedShop(SHOP_ID, "lang-test.myshopify.com");
    const stored = await prisma.shop.update({
      where: { id: shop.id },
      data: { language: "klingon" },
      select: { language: true },
    });

    expect(stored.language).toBe("klingon");

    // The column is a plain string, not an enum, so the database will happily
    // accept and keep a value no locale file can ever resolve. The only guard is
    // `isSupportedLanguage` in the resource route, which is why it is asserted
    // here: it cannot later be dropped as redundant if the column is a string.
    expect(isSupportedLanguage(stored.language)).toBe(false);
  });
});
describe("dashboard response/order join", () => {
  /**
   * The dashboard used to read orders through `include: { order: true }`, which
   * threw `Unknown field 'order'` on every request because `SurveyResponse` has
   * no such relation. `tsc` passed because the include sat behind an `as const`
   * cast against a hand-written return type — only executing it caught the bug.
   *
   * This calls the real `fetchResponsesInWindow` rather than re-running a copy of
   * its SQL. An earlier draft pasted the query in here, which asserted nothing
   * about production code: the copy carried its own WHERE clause, so the query
   * could change without the test noticing. Executing the real function is what
   * makes a reintroduced Prisma include or a dropped LEFT JOIN fail here.
   */
  let shopRowId = "";

  const WINDOW = {
    start: new Date("2026-10-01T00:00:00Z"),
    end: new Date("2026-10-02T00:00:00Z"),
  };

  const fetchRows = () => fetchResponsesInWindow({ shopId: shopRowId, ...WINDOW });

  beforeAll(async () => {
    const shop = await seedShop(SHOP_ID, "join.myshopify.com");
    shopRowId = shop.id;

    await prisma.orderCache.upsert({
      where: { shopId_orderId: { shopId: shop.id, orderId: "77001" } },
      update: {},
      create: {
        shopId: shop.id,
        orderId: "77001",
        currency: "KWD",
        // Three-decimal currency: Decimal(12,2) would have rounded this away.
        totalPrice: "1.234",
        totalRefunded: "0.111",
        financialStatus: "partially_refunded",
        isTest: false,
        isCancelled: false,
        createdAtShop: new Date("2026-10-01T00:00:00Z"),
        updatedAtShop: new Date("2026-10-01T00:00:00Z"),
      },
    });

    // Two answers: one with a matching order, one whose order webhook never
    // arrived. The second is the case an inner join would silently drop.
    await prisma.surveyResponse.create({
      data: {
        shopId: shop.id,
        orderId: "77001",
        channel: "instagram",
        submittedAt: new Date("2026-10-01T01:00:00Z"),
      },
    });
    await prisma.surveyResponse.create({
      data: {
        shopId: shop.id,
        orderId: "77099",
        channel: "google",
        submittedAt: new Date("2026-10-01T02:00:00Z"),
      },
    });
  });

  it("keeps an answer whose order has not arrived yet", async () => {
    const rows = await fetchRows();
    expect(rows.map((r) => r.orderId)).toEqual(["77099", "77001"]);
  });

  it("returns null order columns for the unreconciled answer", async () => {
    const rows = await fetchRows();
    const pending = rows.find((r) => r.orderId === "77099");
    expect(pending).toBeDefined();
    expect(pending?.order).toBeNull();
    expect(pending?.channel).toBe("google");
  });

  it("returns money as strings, preserving three decimal places", async () => {
    const rows = await fetchRows();
    const matched = rows.find((r) => r.orderId === "77001");
    expect(matched?.order?.totalPrice).toBe("1.234");
    expect(matched?.order?.totalRefunded).toBe("0.111");
    expect(matched?.order?.currency).toBe("KWD");
  });

  it("scopes rows to the requested window and shop", async () => {
    // Guards the other half of the query: an unbounded or shop-agnostic read
    // would look correct above while leaking another merchant's answers here.
    // A distinct orderId: (shopId, orderId) is unique, so reusing 77001 would
    // violate the index rather than test the window boundary.
    await prisma.surveyResponse.create({
      data: {
        shopId: shopRowId,
        orderId: "77002",
        channel: "friend",
        submittedAt: new Date("2026-10-05T00:00:00Z"),
      },
    });

    const otherShop = await seedShop(OTHER_SHOP_ID, "join-other.myshopify.com");
    await prisma.surveyResponse.create({
      data: {
        shopId: otherShop.id,
        orderId: "77001",
        channel: "friend",
        submittedAt: new Date("2026-10-01T03:00:00Z"),
      },
    });

    const rows = await fetchRows();
    expect(rows.map((r) => r.orderId).sort()).toEqual(["77001", "77099"]);
    expect(rows.every((r) => r.channel !== "friend")).toBe(true);
  });
});

describe("order webhook money reconciliation", () => {
  /**
   * `OrderCache.totalPrice` is NOT NULL, so an unparseable Shopify total still
   * has to be written as something — the upsert writes "0.00". That fallback is
   * only safe because `upsertOrderCache` returns *before* reconciling when the
   * total did not parse.
   *
   * Without that early return the "0.00" parses cleanly, so every response that
   * was waiting for its order gets stamped with a zero order total and silently
   * stops counting as revenue. The merchant sees a real order reported at $0.00,
   * indistinguishable from a genuine free order. These assert the answer stays
   * unreconciled, which is what "Pending" on the dashboard depends on.
   */
  const SHOP_DOMAIN = "money.myshopify.com";
  let shopRowId = "";

  const orderPayload = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 55001,
      currency: "USD",
      financial_status: "paid",
      test: false,
      cancelled_at: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      current_total_price: "42.50",
      ...overrides,
    }) as unknown as Parameters<typeof processWebhook>[0]["payload"];

  beforeAll(async () => {
    const shop = await seedShop(SHOP_DOMAIN, SHOP_DOMAIN);
    shopRowId = shop.id;
  });

  beforeEach(async () => {
    // An answer that arrives before orders/create, so it waits to be reconciled.
    await prisma.surveyResponse.deleteMany({ where: { shopId: shopRowId } });
    await prisma.orderCache.deleteMany({ where: { shopId: shopRowId } });
    await prisma.surveyResponse.create({
      data: {
        shopId: shopRowId,
        orderId: "55001",
        channel: "instagram",
        submittedAt: new Date("2026-10-01T00:30:00Z"),
      },
    });
  });

  it("reconciles with the real total when the amount parses", async () => {
    const result = await processWebhook({
      topic: "orders/create",
      shopDomain: SHOP_DOMAIN,
      accessToken: null,
      payload: orderPayload(),
    });

    expect(result).toMatchObject({ action: "orders_upserted", orderId: "55001", reconciled: 1 });

    const [response] = await prisma.surveyResponse.findMany({ where: { shopId: shopRowId } });
    expect(response?.reconciled).toBe(true);
    expect(response?.orderTotal?.toString()).toBe("42.5");
    expect(response?.currency).toBe("USD");
  });

  it("leaves the answer unreconciled when the total cannot be parsed", async () => {
    const result = await processWebhook({
      topic: "orders/create",
      shopDomain: SHOP_DOMAIN,
      accessToken: null,
      // A total that is not a number at all: parseMoneyToMinor rejects it.
      payload: orderPayload({ current_total_price: "not-a-number" }),
    });

    expect(result).toMatchObject({ action: "orders_upserted", reconciled: 0 });

    const [response] = await prisma.surveyResponse.findMany({ where: { shopId: shopRowId } });
    // The whole point: no fabricated revenue, still waiting for a real total.
    expect(response?.reconciled).toBe(false);
    expect(response?.orderTotal).toBeNull();
    expect(response?.currency).toBeNull();
  });

  it("stores the fallback total without stamping it onto the answer", async () => {
    await processWebhook({
      topic: "orders/create",
      shopDomain: SHOP_DOMAIN,
      accessToken: null,
      payload: orderPayload({ current_total_price: "not-a-number" }),
    });

    // The order row still needs a value to satisfy NOT NULL, but it must not be
    // reachable as if it were real revenue.
    const order = await prisma.orderCache.findFirst({
      where: { shopId: shopRowId, orderId: "55001" },
    });
    expect(order?.totalPrice.toString()).toBe("0");

    const [response] = await prisma.surveyResponse.findMany({ where: { shopId: shopRowId } });
    expect(response?.orderTotal).toBeNull();
  });
});
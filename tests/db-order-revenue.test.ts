/**
 * End-to-end checks against a real Postgres: a webhook payload goes in through the
 * real `processWebhook`, and the numbers come out through the real
 * `fetchResponsesInWindow` / `toDecidedAmounts` / `toExportRows`. Nothing is
 * mocked and no SQL is copied, so a regression anywhere on that path fails here.
 *
 * Shop domains and webhook ids are unique to this file so it can run in parallel
 * with the other DB suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import {
  decideRevenue,
  fetchResponsesInWindow,
  toDecidedAmounts,
  toExportRows,
} from "~/lib/analytics-queries.server";
import { handleShopRedact } from "~/lib/compliance.server";
import { minorToDecimalString } from "~/lib/money";
import { submitResponse } from "~/lib/responses.server";
import { upsertShop } from "~/lib/shop.server";
import { claimWebhook, processWebhook } from "~/lib/webhooks.server";

const prisma = new PrismaClient();

const WINDOW = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") };

const REV_DOMAIN = "netrev-revenue.myshopify.com";
const REV_GID = "gid://shopify/Shop/9100001";
const LIFE_DOMAIN = "netrev-lifecycle.myshopify.com";
const LIFE_GID = "gid://shopify/Shop/9100002";
const GHOST_DOMAIN = "netrev-ghost.myshopify.com";

const hour = (h: number) => `2026-10-01T${String(h).padStart(2, "0")}:00:00Z`;

type Payload = Parameters<typeof processWebhook>[0]["payload"];

const orderPayload = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 910001,
    currency: "USD",
    financial_status: "paid",
    test: false,
    cancelled_at: null,
    created_at: hour(10),
    updated_at: hour(10),
    current_total_price: "100.00",
    ...overrides,
  }) as unknown as Payload;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
  await cleanup();
});

async function cleanup() {
  await prisma.session.deleteMany({ where: { id: { startsWith: "netrev-" } } });
  await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "netrev-" } } });
  // Cascades to responses, orders and usage.
  await prisma.shop.deleteMany({
    where: { shopDomain: { in: [REV_DOMAIN, LIFE_DOMAIN, GHOST_DOMAIN] } },
  });
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("net revenue through the real webhook path", () => {
  let shopRowId = "";

  const send = (topic: string, overrides: Record<string, unknown> = {}) =>
    processWebhook({
      topic,
      shopDomain: REV_DOMAIN,
      payload: orderPayload(overrides),
      accessToken: null,
    });

  const answer = (orderId = "910001") =>
    prisma.surveyResponse.create({
      data: {
        shopId: shopRowId,
        orderId,
        channel: "instagram",
        submittedAt: new Date("2026-10-01T10:30:00Z"),
      },
    });

  const rows = () => fetchResponsesInWindow({ shopId: shopRowId, ...WINDOW });
  const decided = async () => toDecidedAmounts(await rows());

  beforeEach(async () => {
    await cleanup();
    const shop = await prisma.shop.create({
      data: { shopId: REV_GID, shopDomain: REV_DOMAIN, installState: "installed" },
    });
    shopRowId = shop.id;
  });

  it("counts a paid order at current_total_price", async () => {
    await answer();
    await send("orders/create");

    expect(await decided()).toEqual([expect.objectContaining({ currency: "USD", minor: 10000 })]);
  });

  it("deducts a partial refund exactly once, even if a refund field is present", async () => {
    await answer();
    await send("orders/create");
    await send("orders/updated", {
      financial_status: "partially_refunded",
      current_total_price: "75.00",
      // Not a documented order field. It must have no effect.
      total_refunded: "25.00",
      updated_at: hour(11),
    });

    expect(await decided()).toEqual([expect.objectContaining({ minor: 7500 })]);
  });

  it("follows multiple partial refunds", async () => {
    await answer();
    await send("orders/create");
    await send("orders/updated", {
      financial_status: "partially_refunded",
      current_total_price: "80.00",
      updated_at: hour(11),
    });
    await send("orders/updated", {
      financial_status: "partially_refunded",
      current_total_price: "55.00",
      updated_at: hour(12),
    });

    expect(await decided()).toEqual([expect.objectContaining({ minor: 5500 })]);
  });

  it("drops a fully refunded order from revenue but keeps the answer", async () => {
    await answer();
    await send("orders/create");
    await send("orders/updated", {
      financial_status: "refunded",
      current_total_price: "0.00",
      updated_at: hour(11),
    });

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.order).not.toBeNull();
    expect(toDecidedAmounts(all)).toEqual([]);
  });

  it("excludes a cancelled order, via orders/cancelled and via orders/updated", async () => {
    await answer();
    await send("orders/create");
    // The cancelled payload omits cancelled_at: the topic alone must cancel it.
    await send("orders/cancelled", { updated_at: hour(11) });
    expect(await decided()).toEqual([]);

    await prisma.orderCache.deleteMany({ where: { shopId: shopRowId } });
    await send("orders/create");
    await send("orders/updated", { cancelled_at: hour(12), updated_at: hour(12) });
    expect(await decided()).toEqual([]);
  });

  it("excludes a test order", async () => {
    await answer();
    await send("orders/create", { test: true });

    expect(await decided()).toEqual([]);
  });

  it("follows an order edit", async () => {
    await answer();
    await send("orders/create");
    await send("orders/updated", { current_total_price: "120.00", updated_at: hour(11) });

    expect(await decided()).toEqual([expect.objectContaining({ minor: 12000 })]);
  });

  it("keeps 0, 2 and 3 decimal currencies exact", async () => {
    await answer("910002");
    await answer("910003");
    await send("orders/create", { id: 910002, currency: "KWD", current_total_price: "1.234" });
    await send("orders/create", { id: 910003, currency: "JPY", current_total_price: "5000" });

    const amounts = await decided();
    expect(amounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: "KWD", minor: 1234 }),
        expect.objectContaining({ currency: "JPY", minor: 5000 }),
      ]),
    );
    expect(amounts).toHaveLength(2);
  });

  it("ignores a stale, out-of-order delivery", async () => {
    await answer();
    await send("orders/create");
    await send("orders/updated", { current_total_price: "50.00", updated_at: hour(12) });

    // An older update arriving late must not roll the order back to 90.00.
    const late = await send("orders/updated", { current_total_price: "90.00", updated_at: hour(11) });

    expect(late).toMatchObject({ action: "order_stale_ignored" });
    expect(await decided()).toEqual([expect.objectContaining({ minor: 5000 })]);
  });

  it("re-applying the same delivery is harmless", async () => {
    await answer();
    await send("orders/create");
    await send("orders/create");

    expect(await prisma.orderCache.count({ where: { shopId: shopRowId } })).toBe(1);
    expect(await decided()).toEqual([expect.objectContaining({ minor: 10000 })]);
  });

  it("an unparseable update never overwrites a good stored total", async () => {
    await answer();
    await send("orders/create");
    await send("orders/updated", { current_total_price: "garbage", updated_at: hour(11) });

    expect(await decided()).toEqual([expect.objectContaining({ minor: 10000 })]);
  });

  it("an order that never had a parseable total stays pending, not $0.00", async () => {
    await answer();
    await send("orders/create", { current_total_price: "garbage" });

    const all = await rows();
    expect(all[0]?.reconciled).toBe(false);
    expect(all[0]?.order?.totalPrice).toBeNull();
    expect(toDecidedAmounts(all)).toEqual([]);
  });

  it("ignores a payload it cannot store instead of throwing", async () => {
    const result = await send("orders/create", { id: "not-an-id" });
    expect(result).toMatchObject({ action: "order_payload_invalid" });

    const bad = await send("orders/create", { updated_at: "not-a-date" });
    expect(bad).toMatchObject({ action: "order_payload_invalid" });
    expect(await prisma.orderCache.count({ where: { shopId: shopRowId } })).toBe(0);
  });

  it("an answer submitted AFTER orders/create is reconciled at submit time", async () => {
    await send("orders/create", { current_total_price: "64.00" });

    await submitResponse({
      shopId: shopRowId,
      orderId: "910001",
      channel: "instagram",
      otherText: null,
      locale: null,
      plan: "growth",
    });

    const all = await rows();
    expect(all[0]?.reconciled).toBe(true);
    expect(toDecidedAmounts(all)).toEqual([expect.objectContaining({ minor: 6400 })]);
  });

  it("CSV rows carry exactly the dashboard's decision, row by row", async () => {
    // Counted, partially refunded (net 75.00).
    await answer("910001");
    await send("orders/create");
    await send("orders/updated", {
      financial_status: "partially_refunded",
      current_total_price: "75.00",
      updated_at: hour(11),
    });
    // Cancelled, test, and pending (order never arrives).
    await answer("910004");
    await send("orders/create", { id: 910004, cancelled_at: hour(10) });
    await answer("910005");
    await send("orders/create", { id: 910005, test: true });
    await answer("910006");
    // Zero-decimal currency.
    await answer("910007");
    await send("orders/create", { id: 910007, currency: "JPY", current_total_price: "5000" });

    const all = await rows();
    const exported = toExportRows(all);
    expect(exported).toHaveLength(all.length);

    for (const row of all) {
      const csv = exported.find((e) => e.orderId === row.orderId);
      const decision = decideRevenue(row);

      if (decision.included && row.order) {
        expect(csv?.orderTotal).toBe(minorToDecimalString(decision.minor, row.order.currency));
        expect(csv?.currency).toBe(row.order.currency);
      } else {
        // Not counted on the dashboard, so blank in the file. Never "0.00".
        expect(csv?.orderTotal).toBeNull();
        expect(csv?.currency).toBeNull();
      }
    }

    expect(exported.find((e) => e.orderId === "910001")?.orderTotal).toBe("75.00");
    expect(exported.find((e) => e.orderId === "910007")?.orderTotal).toBe("5000");
    expect(exported.find((e) => e.orderId === "910004")?.orderTotal).toBeNull();
    expect(exported.find((e) => e.orderId === "910005")?.orderTotal).toBeNull();
    expect(exported.find((e) => e.orderId === "910006")?.orderTotal).toBeNull();
  });
});

describe("uninstalled and unknown shops stay that way", () => {
  const send = (topic: string, shopDomain: string, overrides: Record<string, unknown> = {}) =>
    processWebhook({ topic, shopDomain, payload: orderPayload(overrides), accessToken: null });

  const shopState = () =>
    prisma.shop.findUnique({ where: { shopDomain: LIFE_DOMAIN }, select: { id: true, installState: true } });

  beforeEach(async () => {
    await cleanup();
    await prisma.shop.create({
      data: { shopId: LIFE_GID, shopDomain: LIFE_DOMAIN, installState: "installed" },
    });
    await prisma.session.create({
      data: { id: "netrev-sess-1", shop: LIFE_DOMAIN, state: "s", accessToken: "shpat_secret" },
    });
  });

  it("deletes stored sessions on uninstall, then ignores a late order webhook", async () => {
    const uninstalled = await processWebhook({
      topic: "app/uninstalled",
      shopDomain: LIFE_DOMAIN,
      payload: {},
      accessToken: null,
    });
    expect(uninstalled).toMatchObject({ action: "app_uninstalled" });
    expect(await prisma.session.count({ where: { shop: LIFE_DOMAIN } })).toBe(0);
    expect((await shopState())?.installState).toBe("uninstalled");

    // A late orders/updated must neither revive the shop nor store the order.
    const late = await send("orders/updated", LIFE_DOMAIN);
    expect(late).toMatchObject({ action: "ignored_shop_not_installed" });

    const after = await shopState();
    expect(after?.installState).toBe("uninstalled");
    expect(await prisma.orderCache.count({ where: { shopId: after?.id } })).toBe(0);
  });

  it("acknowledges an order webhook for an unknown shop without creating it", async () => {
    const result = await send("orders/create", GHOST_DOMAIN);

    expect(result).toMatchObject({ action: "ignored_shop_not_installed" });
    expect(await prisma.shop.findUnique({ where: { shopDomain: GHOST_DOMAIN } })).toBeNull();
  });

  it("reinstalls only through the auth path, after which orders flow again", async () => {
    await processWebhook({ topic: "app/uninstalled", shopDomain: LIFE_DOMAIN, payload: {}, accessToken: null });
    expect((await send("orders/create", LIFE_DOMAIN)).action).toBe("ignored_shop_not_installed");

    // provisionShop's persistence step.
    await upsertShop({ shopDomain: LIFE_DOMAIN, shopId: LIFE_GID, accessToken: null });
    expect((await shopState())?.installState).toBe("installed");

    expect(await send("orders/create", LIFE_DOMAIN)).toMatchObject({ action: "orders_upserted" });
  });

  it("shop/redact deletes the shop and every stored session", async () => {
    const result = await handleShopRedact({ shopDomain: LIFE_DOMAIN });

    expect(result).toEqual({ shopFound: true, deleted: true });
    expect(await prisma.session.count({ where: { shop: LIFE_DOMAIN } })).toBe(0);
    expect(await shopState()).toBeNull();
  });
});

describe("webhook ledger: abandoned deliveries", () => {
  beforeEach(cleanup);

  it("re-claims a delivery whose request died long ago without recording an outcome", async () => {
    await prisma.webhookEvent.create({
      data: {
        webhookId: "netrev-stale",
        topic: "orders/create",
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    expect(
      await claimWebhook({ webhookId: "netrev-stale", topic: "orders/create", apiVersion: null }),
    ).toEqual({ claimed: true });
  });

  it("still refuses a delivery that only just started", async () => {
    await prisma.webhookEvent.create({
      data: { webhookId: "netrev-fresh", topic: "orders/create" },
    });

    expect(
      await claimWebhook({ webhookId: "netrev-fresh", topic: "orders/create", apiVersion: null }),
    ).toEqual({ claimed: false });
  });
});

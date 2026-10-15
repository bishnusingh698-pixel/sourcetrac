/**
 * Billing (BILL flow), against real Postgres with only Shopify's Admin API
 * stubbed at `fetch`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { activeSourceTracSubscription, fetchActiveSubscriptions } from "~/lib/billing.server";
import { setPlan, upsertShop } from "~/lib/shop.server";
import { normaliseSubscriptionStatus, processWebhook } from "~/lib/webhooks.server";

const prisma = new PrismaClient();
const DOMAIN = "billing-flow-test.myshopify.com";
let shopId = "";
const A = "gid://shopify/AppSubscription/1";
const B = "gid://shopify/AppSubscription/2";

function stubActive(subscriptions: Array<{ id: string; name: string; status: string; test?: boolean }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            appInstallation: {
              activeSubscriptions: subscriptions.map((s) => ({ test: false, currentPeriodEnd: null, ...s })),
            },
          },
        }),
        { status: 200 },
      ),
    ),
  );
}

const notice = (gid: string, name: string, status: string) => ({
  app_subscription: { admin_graphql_api_id: gid, name, status },
});

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/960000", accessToken: "shpat_x" })).id;
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("subscription notices", () => {
  it("ignores an old plan's late ACTIVE retry after an upgrade (M13)", async () => {
    await setPlan(shopId, { plan: "scale", planStatus: "active", subscriptionGid: B });
    stubActive([{ id: B, name: "SourceTrac Scale", status: "ACTIVE" }]);
    await processWebhook({ topic: "app_subscriptions/update", shopDomain: DOMAIN, payload: notice(A, "SourceTrac Growth", "ACTIVE"), accessToken: "t" });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    expect(shop.plan).toBe("scale");
    expect(shop.subscriptionGid).toBe(B);
  });

  it("ignores a PENDING arriving after the charge is already active (M13)", async () => {
    await setPlan(shopId, { plan: "growth", planStatus: "active", subscriptionGid: A });
    stubActive([{ id: A, name: "SourceTrac Growth", status: "ACTIVE" }]);
    await processWebhook({ topic: "app_subscriptions/update", shopDomain: DOMAIN, payload: notice(A, "SourceTrac Growth", "PENDING"), accessToken: "t" });
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).planStatus).toBe("active");
  });

  it("applies a superseded CANCELLED only to the subscription still held (H18)", async () => {
    await setPlan(shopId, { plan: "scale", planStatus: "active", subscriptionGid: B });
    await processWebhook({ topic: "app_subscriptions/update", shopDomain: DOMAIN, payload: notice(A, "SourceTrac Growth", "CANCELLED"), accessToken: null });
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).plan).toBe("scale");
  });

  it("does not grant a paid plan for a test charge on a live store in production (M14)", async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
          const query = (JSON.parse(init.body) as { query: string }).query;
          const data = query.includes("partnerDevelopment")
            ? { shop: { plan: { publicDisplayName: "Basic", partnerDevelopment: false } } }
            : { appInstallation: { activeSubscriptions: [{ id: A, name: "SourceTrac Growth", status: "ACTIVE", test: true, currentPeriodEnd: null }] } };
          return new Response(JSON.stringify({ data }), { status: 200 });
        }),
      );
      await processWebhook({ topic: "app_subscriptions/update", shopDomain: DOMAIN, payload: notice(A, "SourceTrac Growth", "ACTIVE"), accessToken: "t" });
    } finally {
      process.env.NODE_ENV = env;
    }
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).plan).toBe("free");
  });
});

describe("billing helpers", () => {
  it("refuses an answer with no app installation instead of reading it as Free (L34)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { appInstallation: null } }), { status: 200 })));
    await expect(fetchActiveSubscriptions({ shopDomain: DOMAIN, accessToken: "t" })).rejects.toThrow();
  });

  it("skips a test charge when choosing the subscription to cancel (L36)", () => {
    const subs = [
      { id: "t", name: "SourceTrac Growth", status: "ACTIVE", test: true, currentPeriodEnd: null },
      { id: "real", name: "SourceTrac Growth", status: "ACTIVE", test: false, currentPeriodEnd: null },
    ];
    expect(activeSourceTracSubscription(subs, { allowTest: false })?.id).toBe("real");
  });

  it("maps ACCEPTED to a pending status, not expired (I20)", () => {
    expect(normaliseSubscriptionStatus("ACCEPTED")).toBe("frozen");
  });

  it("unlocks over-cap answers once the shop is on a paid plan (I20)", async () => {
    const survey = await prisma.survey.create({ data: { shopId, name: "S", placements: "[]" } });
    await prisma.response.create({ data: { shopId, surveyId: survey.id, surveyVersion: 1, placement: "thank_you", flagged: true } });
    await setPlan(shopId, { plan: "growth", planStatus: "active", subscriptionGid: A });
    expect(await prisma.response.count({ where: { shopId, flagged: true } })).toBe(0);
  });
});

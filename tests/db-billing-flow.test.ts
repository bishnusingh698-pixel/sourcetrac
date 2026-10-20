/**
 * Billing (BILL flow), against real Postgres with only Shopify's Admin API
 * stubbed at `fetch`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  activeSourceTracSubscription,
  clearDevStoreCache,
  createSubscription,
  fetchActiveSubscriptions,
} from "~/lib/billing.server";
import { setPlan, upsertShop } from "~/lib/shop.server";
import { normaliseSubscriptionStatus, processWebhook } from "~/lib/webhooks.server";
import { stubShopifyBilling, type StubSubscription } from "./helpers/shopify-billing";

const prisma = new PrismaClient();
const DOMAIN = "billing-flow-test.myshopify.com";
let shopId = "";
const A = "gid://shopify/AppSubscription/1";
const B = "gid://shopify/AppSubscription/2";

/** Shopify's state of each charge; anything not listed is unknown to Shopify. */
function stubActive(subscriptions: StubSubscription[]) {
  stubShopifyBilling(subscriptions);
}

const notice = (gid: string, name: string, status: string) => ({
  app_subscription: { admin_graphql_api_id: gid, name, status },
});

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/960000" })).id;
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("subscription notices", () => {
  it("ignores an old plan's late ACTIVE retry after an upgrade (M13)", async () => {
    await setPlan(shopId, { plan: "scale", planStatus: "active", subscriptionGid: B });
    stubActive([
      { id: A, name: "SourceTrac Growth", status: "CANCELLED" },
      { id: B, name: "SourceTrac Scale", status: "ACTIVE" },
    ]);
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
    stubActive([
      { id: A, name: "SourceTrac Growth", status: "CANCELLED" },
      { id: B, name: "SourceTrac Scale", status: "ACTIVE" },
    ]);
    await processWebhook({ topic: "app_subscriptions/update", shopDomain: DOMAIN, payload: notice(A, "SourceTrac Growth", "CANCELLED"), accessToken: "t" });
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).plan).toBe("scale");
  });

  it("does not grant a paid plan for a test charge on a live store in production (M14)", async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      stubActive([{ id: A, name: "SourceTrac Growth", status: "ACTIVE", test: true }]);
      await processWebhook({ topic: "app_subscriptions/update", shopDomain: DOMAIN, payload: notice(A, "SourceTrac Growth", "ACTIVE"), accessToken: "t" });
    } finally {
      process.env.NODE_ENV = env;
    }
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).plan).toBe("free");
  });
});

describe("yearly billing", () => {
  it("asks Shopify for an ANNUAL charge at the yearly price", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            appSubscriptionCreate: {
              appSubscription: { id: A, status: "PENDING", name: "SourceTrac Growth (yearly)", test: true },
              confirmationUrl: "https://admin.shopify.com/store/x/charges/1/confirm",
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const created = await createSubscription({ shopDomain: DOMAIN, accessToken: "t", plan: "growth", cycle: "yearly", test: true });
    expect(created.ok).toBe(true);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const { variables } = JSON.parse(String(init.body)) as {
      variables: { name: string; lineItems: Array<{ plan: { appRecurringPricingDetails: { interval: string; price: { amount: string } } } }> };
    };
    expect(variables.name).toContain("(yearly)");
    expect(variables.lineItems[0]?.plan.appRecurringPricingDetails.interval).toBe("ANNUAL");
    expect(variables.lineItems[0]?.plan.appRecurringPricingDetails.price.amount).toBe("53.89");
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

describe("billing (2026-10-20 audit)", () => {
  it("retries a notice it cannot confirm with Shopify instead of applying it (L34)", async () => {
    await expect(
      processWebhook({ topic: "app_subscriptions/update", shopDomain: DOMAIN, payload: notice(A, "SourceTrac Growth", "ACTIVE"), accessToken: null }),
    ).rejects.toThrow();
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).plan).toBe("free");
  });

  it("retries a development store's test charge when the store type cannot be read (L32)", async () => {
    clearDevStoreCache();
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
          const query = (JSON.parse(init.body) as { query: string }).query;
          if (query.includes("partnerDevelopment")) return new Response("{}", { status: 403 });
          return new Response(
            JSON.stringify({ data: { node: { id: A, name: "SourceTrac Growth", status: "ACTIVE", test: true, currentPeriodEnd: null } } }),
            { status: 200 },
          );
        }),
      );
      await expect(
        processWebhook({ topic: "app_subscriptions/update", shopDomain: DOMAIN, payload: notice(A, "SourceTrac Growth", "ACTIVE"), accessToken: "t" }),
      ).rejects.toThrow();
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it("leaves a reinstalled shop on Free when a late cancellation arrives (I17)", async () => {
    stubActive([{ id: A, name: "SourceTrac Growth", status: "CANCELLED" }]);
    await processWebhook({ topic: "app_subscriptions/update", shopDomain: DOMAIN, payload: notice(A, "SourceTrac Growth", "CANCELLED"), accessToken: "t" });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    expect(shop).toMatchObject({ plan: "free", subscriptionGid: null });
  });

  it("does not overwrite a plan that changed since it was read (L37)", async () => {
    await setPlan(shopId, { plan: "growth", planStatus: "active", subscriptionGid: A });
    const written = await setPlan(
      shopId,
      { plan: "free", planStatus: "expired", subscriptionGid: null },
      { onlyIf: { plan: "free", planStatus: "active", subscriptionGid: null } },
    );
    expect(written).toBe(false);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).plan).toBe("growth");
  });

  it("cancels with a prorated credit and treats an already-cancelled charge as done (M15, L39)", async () => {
    const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
        bodies.push(body);
        const data = body.query.includes("appSubscriptionCancel")
          ? { appSubscriptionCancel: { appSubscription: null, userErrors: [{ field: null, message: "Subscription is already cancelled" }] } }
          : { node: { id: A, name: "SourceTrac Growth", status: "CANCELLED", test: false, currentPeriodEnd: null } };
        return new Response(JSON.stringify({ data }), { status: 200 });
      }),
    );
    const { cancelSubscription } = await import("~/lib/billing.server");
    const result = await cancelSubscription({ shopDomain: DOMAIN, accessToken: "t", subscriptionGid: A });
    expect(result.ok).toBe(true);
    expect(bodies[0]!.variables.prorate).toBe(true);
  });
});

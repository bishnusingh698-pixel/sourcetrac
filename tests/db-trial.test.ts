/**
 * The 14-day free trial on Growth and Scale, through the real Plans page
 * (loader and action, real `authenticate.admin`) and the real billing
 * webhook, against Postgres. Shopify's Admin API is stubbed at `fetch` and
 * records every `appSubscriptionCreate` so the trial the app asked for can be
 * read back.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { clearDevStoreCache } from "~/lib/billing.server";
import { handleShopRedact } from "~/lib/compliance.server";
import { effectivePlan, evaluateCap, TRIAL_DAYS } from "~/lib/plans";
import { upsertShop } from "~/lib/shop.server";
import { clearShopDisplayCache } from "~/lib/studio.server";
import { remainingTrialDays, trialDomainKey } from "~/lib/trial.server";
import { processWebhook } from "~/lib/webhooks.server";
import { action as plansAction, loader as plansLoader } from "~/routes/app.plans";
import { adminForm, adminRequest, runRoute, seedOfflineSession } from "./helpers/admin-request";

const prisma = new PrismaClient();
const DOMAIN = "trial-test.myshopify.com";
const SHOP_GID = "gid://shopify/Shop/990001";
const DAY = 24 * 60 * 60 * 1000;
let shopId = "";

type Sub = {
  id: string;
  name: string;
  status: string;
  test?: boolean;
  trialDays?: number;
  createdAt?: string;
  interval?: "EVERY_30_DAYS" | "ANNUAL";
};

/** Shopify's billing state, and every charge the app created. */
let subs: Sub[] = [];
let created: Array<Record<string, unknown>> = [];
let developmentStore = false;

function stubShopify() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
      const full = (s: Sub) => ({
        test: false,
        currentPeriodEnd: null,
        trialDays: 0,
        createdAt: new Date().toISOString(),
        lineItems: [{ plan: { pricingDetails: { __typename: "AppRecurringPricing", interval: s.interval ?? "EVERY_30_DAYS", price: { amount: "4.99", currencyCode: "USD" } } } }],
        ...s,
      });
      let data: unknown;
      if (query.includes("appSubscriptionCreate")) {
        created.push(variables);
        const id = `gid://shopify/AppSubscription/${100 + created.length}`;
        subs.push({ id, name: String(variables.name), status: "PENDING", trialDays: (variables.trialDays as number | null) ?? 0, createdAt: new Date().toISOString() });
        data = {
          appSubscriptionCreate: {
            appSubscription: { id, status: "PENDING", name: variables.name, test: variables.test, trialDays: variables.trialDays ?? 0 },
            confirmationUrl: `https://admin.shopify.com/store/trial-test/charges/${id.split("/").pop()}/confirm_recurring_application_charge?signature=x`,
            userErrors: [],
          },
        };
      } else if (query.includes("appSubscriptionCancel")) {
        const found = subs.find((s) => s.id === variables.id);
        if (found) found.status = "CANCELLED";
        data = { appSubscriptionCancel: { appSubscription: found ? { id: found.id, status: "CANCELLED" } : null, userErrors: [] } };
      } else if (query.includes("partnerDevelopment")) {
        data = { shop: { plan: { publicDisplayName: "Basic", partnerDevelopment: developmentStore } } };
      } else if (query.includes("node(id:")) {
        const found = subs.find((s) => s.id === variables.id);
        data = { node: found ? full(found) : null };
      } else if (query.includes("appInstallation")) {
        data = { appInstallation: { activeSubscriptions: subs.filter((s) => s.status === "ACTIVE").map(full) } };
      } else {
        data = { shop: { ianaTimezone: "UTC" } };
      }
      return new Response(JSON.stringify({ data }), { status: 200 });
    }),
  );
}

/** The merchant approves a charge on Shopify's page: it goes live. */
function approve(id: string, createdAt?: Date) {
  const sub = subs.find((s) => s.id === id)!;
  sub.status = "ACTIVE";
  if (createdAt) sub.createdAt = createdAt.toISOString();
  for (const other of subs) if (other.id !== id && other.status === "ACTIVE") other.status = "CANCELLED";
}

async function notice(id: string, status: string) {
  const sub = subs.find((s) => s.id === id)!;
  await processWebhook({
    topic: "app_subscriptions/update",
    shopDomain: DOMAIN,
    payload: { app_subscription: { admin_graphql_api_id: id, name: sub.name, status } },
    accessToken: "shpat_test_token",
  });
}

async function subscribe(plan: string, cycle = "monthly") {
  return runRoute(plansAction as never, adminForm(DOMAIN, "/app/plans", { intent: "subscribe", plan, cycle })) as Promise<{
    ok: boolean;
    message: { key: string };
    confirmationUrl?: string;
  }>;
}

async function shopRow() {
  return prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
}

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  subs = [];
  created = [];
  developmentStore = false;
  clearDevStoreCache();
  clearShopDisplayCache();
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  await prisma.trialLedger.deleteMany({ where: { domainKey: trialDomainKey(DOMAIN) } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: SHOP_GID })).id;
  await seedOfflineSession(DOMAIN);
  stubShopify();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  await prisma.trialLedger.deleteMany({ where: { domainKey: trialDomainKey(DOMAIN) } });
  await prisma.$disconnect();
});

describe("remainingTrialDays", () => {
  it("is the full trial for a store that never had one, the days left during it, then none", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    expect(remainingTrialDays(null, now)).toBe(TRIAL_DAYS);
    expect(remainingTrialDays({ endsAt: new Date(now.getTime() + 10.5 * DAY) }, now)).toBe(11);
    expect(remainingTrialDays({ endsAt: new Date(now.getTime() + 60_000) }, now)).toBe(1);
    expect(remainingTrialDays({ endsAt: now }, now)).toBe(0);
    expect(remainingTrialDays({ endsAt: new Date(now.getTime() - DAY) }, now)).toBe(0);
  });
});

describe("the 14-day trial", () => {
  it("is asked for on a store's first paid subscription, and shown before approval", async () => {
    const page = (await runRoute(plansLoader as never, adminRequest(DOMAIN, "/app/plans"))) as {
      trial: { offerDays: number; wouldEndOn: string | null; endsOn: string | null };
    };
    expect(page.trial.offerDays).toBe(14);
    expect(page.trial.wouldEndOn).toBeTruthy();
    expect(page.trial.endsOn).toBeNull();

    const outcome = await subscribe("growth");
    expect(outcome.confirmationUrl).toMatch(/^https:\/\/admin\.shopify\.com\//);
    expect(created).toHaveLength(1);
    expect(created[0]!.trialDays).toBe(14);
    expect(created[0]!.replacementBehavior).toBeNull();
  });

  it("gives the full paid plan during the trial, and records the store's one trial", async () => {
    await subscribe("growth");
    const id = subs[0]!.id;
    const createdAt = new Date(Date.now() - 2 * DAY);
    approve(id, createdAt);
    await notice(id, "ACTIVE");

    const shop = await shopRow();
    expect(effectivePlan(shop)).toBe("growth");
    expect(evaluateCap(effectivePlan(shop), 500).cap).toBeNull();
    expect(shop.trialEndsAt?.getTime()).toBe(createdAt.getTime() + 14 * DAY);
    const ledger = await prisma.trialLedger.findMany({ where: { domainKey: trialDomainKey(DOMAIN) } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.endsAt.getTime()).toBe(createdAt.getTime() + 14 * DAY);

    // A replayed notice during the trial changes nothing: no second row, no move.
    await notice(id, "ACTIVE");
    const again = await prisma.trialLedger.findMany({ where: { domainKey: trialDomainKey(DOMAIN) } });
    expect(again).toHaveLength(1);
    expect(again[0]!.endsAt.getTime()).toBe(ledger[0]!.endsAt.getTime());

    const page = (await runRoute(plansLoader as never, adminRequest(DOMAIN, "/app/plans"))) as {
      trial: { offerDays: number; endsOn: string | null; priceAfter: string | null };
    };
    expect(page.trial.endsOn).toBeTruthy();
    expect(page.trial.priceAfter).toBe("$4.99");
    expect(page.trial.offerDays).toBe(12);
  });

  it("carries only the remaining days into a plan switch, and switches at once", async () => {
    await subscribe("growth");
    approve(subs[0]!.id, new Date(Date.now() - 3.5 * DAY));
    await notice(subs[0]!.id, "ACTIVE");

    await subscribe("scale");
    expect(created).toHaveLength(2);
    // 10.5 days left, rounded up to Shopify's whole days.
    expect(created[1]!.trialDays).toBe(11);
    expect(created[1]!.replacementBehavior).toBe("APPLY_IMMEDIATELY");

    // The new charge goes live: the store's trial record never moves.
    approve(subs[1]!.id);
    await notice(subs[1]!.id, "ACTIVE");
    const ledger = await prisma.trialLedger.findMany({ where: { domainKey: trialDomainKey(DOMAIN) } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.plan).toBe("growth");
    expect((await shopRow()).plan).toBe("scale");

    // Switching back and forth cannot stack days: still counted from the same end.
    await subscribe("growth");
    expect(created[2]!.trialDays).toBe(11);
  });

  it("gives a yearly subscription the trial too", async () => {
    await subscribe("scale", "yearly");
    expect(created[0]!.trialDays).toBe(14);
    const line = (created[0]!.lineItems as Array<{ plan: { appRecurringPricingDetails: { interval: string; price: { amount: string } } } }>)[0]!;
    expect(line.plan.appRecurringPricingDetails.interval).toBe("ANNUAL");
    expect(line.plan.appRecurringPricingDetails.price.amount).toBe("107.89");
  });

  it("charges nothing when cancelled during the trial, drops to Free, and keeps every survey", async () => {
    await prisma.survey.create({ data: { shopId, name: "Kept", status: "active", placements: '["thank_you"]' } as never });
    await subscribe("growth");
    approve(subs[0]!.id, new Date(Date.now() - DAY));
    await notice(subs[0]!.id, "ACTIVE");

    const outcome = await runRoute(plansAction as never, adminForm(DOMAIN, "/app/plans", { intent: "cancel" })) as { ok: boolean };
    expect(outcome.ok).toBe(true);
    expect(subs[0]!.status).toBe("CANCELLED");
    await notice(subs[0]!.id, "CANCELLED");

    const shop = await shopRow();
    expect(effectivePlan(shop)).toBe("free");
    expect(shop.trialEndsAt).toBeNull();
    expect(await prisma.survey.count({ where: { shopId } })).toBe(1);

    // Resubscribing the same week continues the same trial, it does not restart it.
    await subscribe("growth");
    expect(created.at(-1)!.trialDays).toBe(13);
  });

  it("is not given again after an uninstall, shop/redact and reinstall", async () => {
    await subscribe("growth");
    approve(subs[0]!.id, new Date(Date.now() - 20 * DAY));
    await notice(subs[0]!.id, "ACTIVE");

    await processWebhook({ topic: "app/uninstalled", shopDomain: DOMAIN, payload: {}, accessToken: null });
    // shop/redact 48 hours later deletes the shop row and everything under it,
    // through the real handler.
    const redacted = await handleShopRedact({ shopDomain: DOMAIN, triggeredAt: new Date(Date.now() + 48 * 60 * 60 * 1000) });
    expect(redacted.deleted).toBe(true);
    expect(await prisma.shop.count({ where: { shopDomain: DOMAIN } })).toBe(0);
    expect(await prisma.trialLedger.count({ where: { domainKey: trialDomainKey(DOMAIN) } })).toBe(1);

    subs = [];
    shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: SHOP_GID })).id;
    await seedOfflineSession(DOMAIN);
    await subscribe("growth");
    expect(created.at(-1)!.trialDays).toBeNull();

    const page = (await runRoute(plansLoader as never, adminRequest(DOMAIN, "/app/plans"))) as { trial: { offerDays: number } };
    expect(page.trial.offerDays).toBe(0);
  });

  it("counts a paid plan bought before trials existed as the store's trial", async () => {
    // A live subscription with no trial and no ledger row (bought earlier).
    subs.push({ id: "gid://shopify/AppSubscription/9", name: "SourceTrac — Growth", status: "ACTIVE", trialDays: 0 });
    await prisma.shop.update({ where: { id: shopId }, data: { plan: "growth", planStatus: "active", subscriptionGid: "gid://shopify/AppSubscription/9" } });

    await subscribe("scale");
    expect(created[0]!.trialDays).toBeNull();
    expect(created[0]!.replacementBehavior).toBeNull();
  });

  it("uses test charges with the trial on a development store in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    developmentStore = true;
    await subscribe("growth");
    expect(created[0]!.test).toBe(true);
    expect(created[0]!.trialDays).toBe(14);
  });
});

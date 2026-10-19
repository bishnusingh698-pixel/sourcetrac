/**
 * The Surveys page's "Checkout check" and "Recent checkouts", against Postgres.
 *
 * Recent checkouts used to live in server memory, so every restart or deploy
 * (exactly when a merchant tests) emptied it. It is stored now, and these
 * tests pin that it survives, stays bounded, and keeps one line per reload.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache, createSurvey } from "~/lib/surveys.server";
import { PER_SHOP, recentServes, recordServe } from "~/lib/serve-log.server";
import { runCheckoutCheck } from "~/lib/checkout-check.server";
import { markBlockAdded } from "~/lib/block-seen.server";
import { runRetentionPurge } from "~/lib/retention.server";

const prisma = new PrismaClient();
const DOMAIN = "checkout-check-test.myshopify.com";
let shopId = "";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9840001" })).id;
});
beforeEach(async () => {
  await prisma.survey.deleteMany({ where: { shopId } });
  await prisma.checkoutLoad.deleteMany({ where: { shopId } });
  await prisma.shop.update({
    where: { id: shopId },
    data: { thankYouBlockSeenAt: null, orderStatusBlockSeenAt: null, plan: "free", planStatus: "active" },
  });
  clearConfigCache();
});
afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

const survey = (name: string, placements: Array<"thank_you" | "order_status"> = ["thank_you"]) => ({
  name,
  placements,
  status: "active" as const,
  layout: "all" as const,
  title: name,
  intro: null,
  buttonLabel: "Submit",
  thankYouText: "Thanks",
  questions: [
    { type: "single_choice" as const, text: "How did you hear about us?", required: true, randomizeOptions: false, allowOther: false, options: [{ label: "A" }, { label: "B" }] },
  ],
});

const load = (
  orderId: string,
  reason: "shown" | "already_answered" = "shown",
  at?: Date,
  placement: "thank_you" | "order_status" = "thank_you",
) => recordServe(shopId, { placement, orderId, surveyId: null, reason, pinned: false, country: "US", isFirstOrder: true, at });

const page = async (names: Map<string, string>, placement: "thank_you" | "order_status") =>
  (await runCheckoutCheck(shopId, names)).pages.find((p) => p.placement === placement);

describe("checkout check", () => {
  it("checks only the Thank-you page for an empty shop: Order status is an optional extra", async () => {
    expect(await runCheckoutCheck(shopId, new Map())).toEqual({
      pages: [{ placement: "thank_you", survey: null, block: { kind: "never" } }],
      planHidden: 0,
    });
  });

  it("names the live survey, and tells a buyer's load from a block that is only placed", async () => {
    const created = await createSurvey(shopId, survey("Channels"));
    const names = new Map([[created.id, "Channels"]]);
    expect((await page(names, "thank_you"))?.survey).toEqual({ name: "Channels", audienceRules: false });

    // "It's already added" (or the checkout editor) proves placement, not that buyers see it.
    await markBlockAdded(shopId, ["thank_you"]);
    expect((await page(names, "thank_you"))?.block.kind).toBe("placed");

    await load("7000000000001");
    expect((await page(names, "thank_you"))?.block.kind).toBe("buyer");
  });

  it("checks the Order status page once a survey shows there, page by page", async () => {
    const created = await createSurvey(shopId, survey("Both", ["thank_you", "order_status"]));
    const names = new Map([[created.id, "Both"]]);
    expect((await page(names, "order_status"))).toMatchObject({ survey: { name: "Both" }, block: { kind: "never" } });

    // A Thank-you load says nothing about the Order status block.
    await load("7000000000010");
    expect((await page(names, "order_status"))?.block.kind).toBe("never");
    await load("7000000000010", "already_answered", undefined, "order_status");
    expect((await page(names, "order_status"))?.block.kind).toBe("buyer");
  });

  it("counts live surveys the plan does not serve", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
    await createSurvey(shopId, survey("One"));
    await createSurvey(shopId, survey("Two"));
    await prisma.shop.update({ where: { id: shopId }, data: { plan: "free", planStatus: "active" } });
    clearConfigCache();
    expect((await runCheckoutCheck(shopId, new Map())).planHidden).toBe(1);
  });
});

describe("recent checkouts", () => {
  it("is stored, so a restart does not empty it", async () => {
    await load("7000000000002");
    // A fresh read from the database, as after a restart.
    expect(await recentServes(shopId)).toMatchObject([{ orderId: "7000000000002", reason: "shown", country: "US", isFirstOrder: true }]);
  });

  it("keeps one line when a buyer reloads the page, moved to the top", async () => {
    const t0 = Date.now();
    await load("7000000000003", "shown", new Date(t0));
    await load("7000000000004", "shown", new Date(t0 + 1000));
    await load("7000000000003", "shown", new Date(t0 + 2000));
    expect((await recentServes(shopId)).map((e) => e.orderId)).toEqual(["7000000000003", "7000000000004"]);
  });

  it("keeps only the newest loads per shop", async () => {
    const t0 = Date.now();
    for (let i = 0; i < PER_SHOP + 3; i += 1) await load(String(7100000000000 + i), "shown", new Date(t0 + i * 1000));
    const rows = await recentServes(shopId);
    expect(rows).toHaveLength(PER_SHOP);
    expect(rows[0]?.orderId).toBe(String(7100000000000 + PER_SHOP + 2));
    expect(await prisma.checkoutLoad.count({ where: { shopId } })).toBe(PER_SHOP);
  });

  it("ignores pages with no block, and ages out after 30 days", async () => {
    await recordServe(shopId, { placement: "onsite", orderId: "1", surveyId: null, reason: "shown", pinned: false, country: null, isFirstOrder: null });
    expect(await recentServes(shopId)).toHaveLength(0);

    await load("7000000000005", "shown", new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    const report = await runRetentionPurge();
    expect(report.checkoutLoadsDeleted).toBeGreaterThanOrEqual(1);
    expect(await recentServes(shopId)).toHaveLength(0);
  });
});

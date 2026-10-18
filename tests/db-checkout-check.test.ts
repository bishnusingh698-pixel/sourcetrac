/**
 * The Surveys page's "Checkout check", against Postgres: what it reports for a
 * shop with no survey, a live survey, an old block and a current one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache, createSurvey } from "~/lib/surveys.server";
import { clearServeLog, recordPreviewLoad, recordServe } from "~/lib/serve-log.server";
import { runCheckoutCheck } from "~/lib/checkout-check.server";
import { CURRENT_BLOCK_BUILD } from "@shared/block-build";

const prisma = new PrismaClient();
const DOMAIN = "checkout-check-test.myshopify.com";
let shopId = "";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9840001", accessToken: null })).id;
});
beforeEach(async () => {
  await prisma.survey.deleteMany({ where: { shopId } });
  clearConfigCache();
  clearServeLog();
});
afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

const survey = (name: string) => ({
  name,
  status: "active" as const,
  placements: ["thank_you" as const],
  layout: "all" as const,
  title: name,
  intro: null,
  buttonLabel: "Submit",
  thankYouText: "Thanks",
  questions: [
    { type: "single_choice" as const, text: "How did you hear about us?", required: true, randomizeOptions: false, allowOther: false, options: [{ label: "A" }, { label: "B" }] },
  ],
});

describe("checkout check", () => {
  it("reports no survey and no block for an empty shop", async () => {
    const check = await runCheckoutCheck(shopId, new Map());
    expect(check.database).toEqual({ ok: true });
    expect(check.pages.find((p) => p.placement === "thank_you")).toMatchObject({ survey: null, block: null });
  });

  it("names the live survey, and tells an old block from a current one", async () => {
    const created = await createSurvey(shopId, survey("Channels"));
    recordServe(shopId, { placement: "thank_you", orderId: "1", surveyId: created.id, reason: "shown", pinned: false, country: null, isFirstOrder: null, blockBuild: null });
    let check = await runCheckoutCheck(shopId, new Map([[created.id, "Channels"]]));
    const page = () => check.pages.find((p) => p.placement === "thank_you")!;
    expect(page().survey).toEqual({ name: "Channels", audienceRules: false });
    expect(page().block).toMatchObject({ outdated: true, where: "buyer" });

    // A newer load in the checkout editor, from the current block.
    recordPreviewLoad(shopId, "thank_you", CURRENT_BLOCK_BUILD, new Date(Date.now() + 1000));
    check = await runCheckoutCheck(shopId, new Map([[created.id, "Channels"]]));
    expect(page().block).toMatchObject({ outdated: false, where: "editor" });
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

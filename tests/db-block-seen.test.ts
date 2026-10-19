/**
 * Whether the SourceTrac block is really on a merchant's Thank-you page.
 *
 * The survey editor used to say "Your survey is live" the moment it was turned
 * on, though buyers see nothing until the block is added in Shopify's checkout
 * editor. Shopify reports no "block added" state, so the block loading is the
 * only proof: a buyer's Thank-you page calling `/api/survey`, or the checkout
 * editor calling `/api/survey-preview`. Driven through the real routes with a
 * signed session token against Postgres.
 */
import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getBlockSeen, markBlockAdded, recordBlockSeen, resetBlockSeenThrottle } from "~/lib/block-seen.server";
import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache, createSurvey } from "~/lib/surveys.server";
import { processWebhook } from "~/lib/webhooks.server";
import { loader as surveyLoader } from "~/routes/api.survey";
import { loader as previewLoader } from "~/routes/api.survey-preview";

const prisma = new PrismaClient();
const DOMAIN = "block-seen-test.myshopify.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const ORDER = encodeURIComponent("gid://shopify/OrderIdentity/7430000000001");

function sessionToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ dest: DOMAIN, aud: process.env.SHOPIFY_API_KEY, exp: now + 300, nbf: now - 5, iat: now - 5, jti: crypto.randomUUID() });
  const signature = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function get(handler: (args: { request: Request }) => Promise<Response>, path: string): Promise<void> {
  const request = new Request(`https://sourcetrac.test${path}`, {
    headers: { Authorization: `Bearer ${sessionToken()}`, Origin: "https://extensions.shopifycdn.com", "User-Agent": UA },
  });
  const res = await handler({ request });
  expect(res.status).toBe(200);
}

let shopId = "";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9710001", accessToken: null });
  shopId = shop.id;
  await createSurvey(shopId, {
    name: "Channels",
    status: "active",
        layout: "all",
    title: "Channels",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      {
        type: "single_choice",
        text: "How did you hear about us?",
        required: true,
        randomizeOptions: false,
        allowOther: false,
        options: [{ label: "Instagram" }, { label: "Google" }],
      },
    ],
  });
  clearConfigCache();
});

beforeEach(async () => {
  resetBlockSeenThrottle();
  await prisma.shop.update({ where: { id: shopId }, data: { thankYouBlockSeenAt: null } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("checkout block seen", () => {
  it("is unseen on a new shop, so a live survey is not called live", async () => {
    expect(await getBlockSeen(shopId)).toBe(false);
  });

  it("is seen once a buyer's Thank-you block asks for a survey", async () => {
    await get(surveyLoader, `/api/survey?orderId=${ORDER}&placement=thank_you`);
    expect(await getBlockSeen(shopId)).toBe(true);
  });

  it("is seen when the checkout editor draws the block", async () => {
    await get(previewLoader, `/api/survey-preview?placement=thank_you`);
    expect(await getBlockSeen(shopId)).toBe(true);
  });

  it("writes at most once an hour", async () => {
    await recordBlockSeen(shopId, "thank_you");
    await prisma.shop.update({ where: { id: shopId }, data: { thankYouBlockSeenAt: null } });
    await recordBlockSeen(shopId, "thank_you");
    expect(await getBlockSeen(shopId)).toBe(false);

    await recordBlockSeen(shopId, "thank_you", new Date(Date.now() + 61 * 60 * 1000));
    expect(await getBlockSeen(shopId)).toBe(true);
  });

  it("ignores pages that have no checkout block", async () => {
    await recordBlockSeen(shopId, "order_status");
    await recordBlockSeen(shopId, "onsite");
    expect(await getBlockSeen(shopId)).toBe(false);
  });

  it("can be confirmed by the merchant when the block has not loaded yet", async () => {
    await markBlockAdded(shopId);
    expect(await getBlockSeen(shopId)).toBe(true);
  });

  it("is forgotten on uninstall, which removes the block", async () => {
    await recordBlockSeen(shopId, "thank_you");
    await processWebhook({ topic: "app/uninstalled", shopDomain: DOMAIN, payload: {}, accessToken: null });
    expect(await getBlockSeen(shopId)).toBe(false);
  });
});

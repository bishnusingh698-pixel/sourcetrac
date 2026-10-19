/**
 * Why a survey did or did not show, driven through the real `/api/survey`
 * route with signed checkout session tokens against Postgres.
 *
 * Each case here was a way the survey silently failed to show (or showed when
 * it should not have), with no word to the merchant:
 *  - A rejected session token came back as a 401 without CORS, which the block
 *    read as a network error and retried for a minute on "Loading…".
 *  - The order-value rule never applied: `valueCurrency` was never set, and on
 *    the Thank-you page the order webhook has not landed, so there was no total.
 *  - A first-time/returning survey could never show on the Order status page,
 *    which has no first-order signal: it now reads what the Thank-you page
 *    reported for the order.
 *  - Nothing told the merchant why: every decision is kept for the Surveys
 *    page's "Recent checkouts".
 */
import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache, createSurvey, type SurveyInput } from "~/lib/surveys.server";
import { resetBuckets } from "~/lib/rate-limit.server";
import { loader as surveyLoader } from "~/routes/api.survey";
import { flushServeLog, recentServes } from "~/lib/serve-log.server";

const prisma = new PrismaClient();
const DOMAIN = "targeting-routes-test.myshopify.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

let shopId = "";

function sessionToken({ secret = process.env.SHOPIFY_API_SECRET ?? "", dest = DOMAIN, exp }: { secret?: string; dest?: string; exp?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ dest, aud: process.env.SHOPIFY_API_KEY, exp: exp ?? now + 300, nbf: now - 5, iat: now - 5, jti: crypto.randomUUID() });
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function call(query: string, token: string | null = sessionToken()): Promise<Response> {
  const headers: Record<string, string> = { Origin: "https://extensions.shopifycdn.com", "User-Agent": UA };
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = new Request(`https://sourcetrac.test/api/survey?${query}`, { headers });
  try {
    return await surveyLoader({ request });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function config(query: string): Promise<{ enabled: boolean; survey: { id: string } | null }> {
  const res = await call(query);
  expect(res.status).toBe(200);
  return (await res.json()) as { enabled: boolean; survey: { id: string } | null };
}

/** What "Recent checkouts" shows for the newest Thank-you page load. */
async function lastServe() {
  await flushServeLog();
  return (await recentServes(shopId))[0];
}

function input(name: string, over: Partial<SurveyInput> = {}): SurveyInput {
  return {
    name,
    status: "active",
    placements: ["thank_you", "order_status"],
    layout: "all",
    title: name,
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
    ...over,
  };
}

let orderSeq = 7_000_000_000;
const nextOrder = () => String((orderSeq += 1));

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9800001", accessToken: null });
  shopId = shop.id;
  // Targeting rules are a Growth feature; Scale includes them.
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
});

beforeEach(async () => {
  await prisma.survey.deleteMany({ where: { shopId } });
  await prisma.checkoutLoad.deleteMany({ where: { shopId } });
  await prisma.orderFact.deleteMany({ where: { shopId } });
  clearConfigCache();
  resetBuckets();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("a refused session token", () => {
  it("answers 401 with CORS, so the block stops at once instead of retrying blind", async () => {
    for (const token of [null, sessionToken({ secret: "not-this-apps-secret" }), sessionToken({ exp: 1 })]) {
      const res = await call("placement=thank_you&orderId=1", token);
      expect(res.status).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  it("accepts a shop domain written as a URL in `dest`", async () => {
    const survey = await createSurvey(shopId, input("Any"));
    const res = await call(`placement=thank_you&orderId=${nextOrder()}`, sessionToken({ dest: `https://${DOMAIN.toUpperCase()}/` }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { survey: { id: string } | null }).survey?.id).toBe(survey.id);
  });
});

describe("the order-value rule", () => {
  it("applies on the Thank-you page from the checkout's total, before the webhook lands", async () => {
    const survey = await createSurvey(shopId, input("Big orders", { targeting: { minValue: 100, valueCurrency: "USD" } }));
    const small = await config(`placement=thank_you&orderId=${nextOrder()}&total=49.99&totalCurrency=USD`);
    expect(small.enabled).toBe(false);
    const big = await config(`placement=thank_you&orderId=${nextOrder()}&total=150&totalCurrency=USD`);
    expect(big.survey?.id).toBe(survey.id);
    // Another currency is not filtered: the bounds are in the store's currency.
    const euro = await config(`placement=thank_you&orderId=${nextOrder()}&total=5&totalCurrency=EUR`);
    expect(euro.survey?.id).toBe(survey.id);
  });

  it("prefers the webhook's total once the order is cached", async () => {
    const survey = await createSurvey(shopId, input("Big orders", { targeting: { minValue: 100, valueCurrency: "USD" } }));
    const orderId = nextOrder();
    const now = new Date();
    await prisma.orderCache.create({
      data: { shopId, orderId, currency: "USD", totalPrice: "250.00", isTest: false, isCancelled: false, createdAtShop: now, updatedAtShop: now },
    });
    // The checkout's figure is ignored when the stored one exists.
    expect((await config(`placement=thank_you&orderId=${orderId}&total=1&totalCurrency=USD`)).survey?.id).toBe(survey.id);
  });
});

describe("first-time and returning buyers", () => {
  it("decides from what the Thank-you page reports, and hides when it reports nothing", async () => {
    const survey = await createSurvey(shopId, input("Newcomers", { targeting: { customerType: "first_order" } }));
    expect((await config(`placement=thank_you&orderId=${nextOrder()}&isFirstOrder=1`)).survey?.id).toBe(survey.id);
    expect((await config(`placement=thank_you&orderId=${nextOrder()}&isFirstOrder=0`)).enabled).toBe(false);
    expect((await config(`placement=thank_you&orderId=${nextOrder()}`)).enabled).toBe(false);
  });

  it("shows a first-order survey on Order status when the Thank-you page reported a first order", async () => {
    const survey = await createSurvey(shopId, input("Newcomers", { targeting: { customerType: "first_order" } }));
    const first = nextOrder();
    const repeat = nextOrder();
    // Thank-you reports the flag; it is remembered for the order.
    expect((await config(`placement=thank_you&orderId=${first}&isFirstOrder=1`)).survey?.id).toBe(survey.id);
    expect((await config(`placement=thank_you&orderId=${repeat}&isFirstOrder=0`)).enabled).toBe(false);

    // Order status has no signal of its own and reads what Thank-you saw.
    expect((await config(`placement=order_status&orderId=${first}`)).survey?.id).toBe(survey.id);
    expect((await config(`placement=order_status&orderId=${repeat}`)).enabled).toBe(false);

    // An order Thank-you never reported stays unknown, and the merchant is told why.
    expect((await config(`placement=order_status&orderId=${nextOrder()}`)).enabled).toBe(false);
    expect(await lastServe()).toMatchObject({ placement: "order_status", reason: "customer_type_unknown" });
  });

  it("shows an everyone survey whatever the page knows", async () => {
    const survey = await createSurvey(shopId, input("Everyone"));
    expect((await config(`placement=thank_you&orderId=${nextOrder()}`)).survey?.id).toBe(survey.id);
  });
});

describe("countries and languages", () => {
  it("matches a country case-insensitively and says when the checkout reported none", async () => {
    const survey = await createSurvey(shopId, input("US only", { targeting: { countries: ["US"] } }));
    expect((await config(`placement=thank_you&orderId=${nextOrder()}&country=us`)).survey?.id).toBe(survey.id);
    expect((await config(`placement=thank_you&orderId=${nextOrder()}&country=DE`)).enabled).toBe(false);
    expect(await lastServe()).toMatchObject({ reason: "country", country: "DE", surveyId: survey.id });
    expect((await config(`placement=thank_you&orderId=${nextOrder()}`)).enabled).toBe(false);
  });

  it("matches a regional language tag to its base language", async () => {
    const survey = await createSurvey(shopId, input("English", { targeting: { languages: ["en"] } }));
    expect((await config(`placement=thank_you&orderId=${nextOrder()}&locale=en-US`)).survey?.id).toBe(survey.id);
    expect((await config(`placement=thank_you&orderId=${nextOrder()}&locale=de`)).enabled).toBe(false);
  });

  it("refuses to save a country code no checkout reports", async () => {
    await expect(createSurvey(shopId, input("Typo", { targeting: { countries: ["USA"] } }))).rejects.toMatchObject({
      fields: { code: "invalid_country" },
    });
  });
});

describe("dates", () => {
  it("refuses an end date before the start date, and an unreadable date", async () => {
    await expect(
      createSurvey(shopId, input("Backwards", { targeting: { startsAt: "2026-05-10T00:00:00.000Z", endsAt: "2026-05-01T00:00:00.000Z" } })),
    ).rejects.toMatchObject({ fields: { code: "end_before_start" } });
    await expect(createSurvey(shopId, input("Garbled", { targeting: { startsAt: "next tuesday" } }))).rejects.toMatchObject({
      fields: { code: "invalid_date" },
    });
  });

  it("reports a survey that has not started yet", async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await createSurvey(shopId, input("Later", { targeting: { startsAt: tomorrow } }));
    expect((await config(`placement=thank_you&orderId=${nextOrder()}`)).enabled).toBe(false);
    expect((await lastServe())?.reason).toBe("not_started");
  });
});

describe("nothing to show", () => {
  it("shows nothing when no survey is live", async () => {
    expect((await config(`placement=thank_you&orderId=${nextOrder()}`)).enabled).toBe(false);
    expect((await lastServe())?.reason).toBe("none_live");
  });

  it("shows nothing on the Order status page unless the survey is set to show there", async () => {
    await createSurvey(shopId, input("Thank-you only", { placements: ["thank_you"] }));
    expect((await config(`placement=order_status&orderId=${nextOrder()}`)).enabled).toBe(false);
    expect(await lastServe()).toMatchObject({ placement: "order_status", reason: "not_on_page" });
    expect((await config(`placement=thank_you&orderId=${nextOrder()}`)).enabled).toBe(true);
  });

  it("tells the block when the order has already answered", async () => {
    const survey = await createSurvey(shopId, input("Any"));
    const orderId = nextOrder();
    await prisma.response.create({
      data: { shopId, surveyId: survey.id, surveyVersion: 1, orderId, placement: "thank_you" },
    });
    // Answered on the Thank-you page, so the Order status page asks nothing.
    const body = (await (await call(`placement=order_status&orderId=${orderId}`)).json()) as { alreadyAnswered: boolean };
    expect(body.alreadyAnswered).toBe(true);
    // The reason a merchant re-using a test order most needs to see.
    expect((await lastServe())?.reason).toBe("already_answered");
  });

  it("shows nothing in place of a pinned survey that is not live", async () => {
    const paused = await createSurvey(shopId, input("Paused", { status: "paused" }));
    await createSurvey(shopId, input("Live"));
    expect((await config(`placement=thank_you&orderId=${nextOrder()}&surveyId=${paused.id}`)).enabled).toBe(false);
    expect(await lastServe()).toMatchObject({ reason: "pinned_not_live", surveyId: paused.id, pinned: true });
  });
});

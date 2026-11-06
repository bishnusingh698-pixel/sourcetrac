/**
 * One store, end to end, through the real entry points only: the quick start
 * creates the survey (admin action), buyers load and answer it (checkout
 * routes, signed session tokens), orders arrive by webhook (before and after
 * the answer), and every report and CSV is read back through its loader.
 *
 * Shopify itself is stubbed at `fetch` only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache } from "~/lib/surveys.server";
import { clearShopDisplayCache } from "~/lib/studio.server";
import { resetBuckets } from "~/lib/rate-limit.server";
import { processWebhook } from "~/lib/webhooks.server";
import { action as quickStartAction } from "~/routes/app.surveys.quick-start";
import { loader as surveyLoader } from "~/routes/api.survey";
import { action as answersAction } from "~/routes/api.survey-responses";
import { loader as dashboardLoader } from "~/routes/app.dashboard";
import { loader as homeLoader } from "~/routes/app._index";
import { loader as resultsLoader } from "~/routes/app.results";
import { loader as responsesLoader } from "~/routes/app.responses";
import { loader as exportCsvLoader } from "~/routes/app.export_.csv";
import { loader as resultsCsvLoader } from "~/routes/app.results_.csv";
import { adminForm, adminRequest, runRoute, seedOfflineSession } from "./helpers/admin-request";
import { callRoute, checkoutRequest } from "./helpers/checkout-request";

const prisma = new PrismaClient();
const DOMAIN = "store-simulation-test.myshopify.com";
let shopId = "";
let surveyId = "";

function stubShopify() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            shop: { ianaTimezone: "America/Los_Angeles", currencyCode: "USD", shopAddress: { countryCodeV2: "US" } },
            appInstallation: { activeSubscriptions: [] },
          },
        }),
        { status: 200 },
      ),
    ),
  );
}

type Config = { enabled: boolean; alreadyAnswered: boolean; survey: { id: string; version: number; questions: Array<{ id: string; options: Array<{ id: string; label: string }> }> } | null };

async function loadConfig(orderId: string): Promise<Config> {
  const res = await callRoute(
    surveyLoader,
    checkoutRequest(DOMAIN, `/api/survey?placement=thank_you&orderId=${encodeURIComponent(`gid://shopify/OrderIdentity/${orderId}`)}&locale=en&products=`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Config;
}

async function answer(orderId: string, label: string) {
  const config = await loadConfig(orderId);
  expect(config.enabled).toBe(true);
  const question = config.survey!.questions[0]!;
  const option = question.options.find((o) => o.label === label);
  expect(option, `option ${label}`).toBeTruthy();
  const res = await callRoute(
    answersAction,
    checkoutRequest(DOMAIN, "/api/survey-responses", {
      method: "POST",
      body: JSON.stringify({
        surveyId: config.survey!.id,
        surveyVersion: config.survey!.version,
        orderId: `gid://shopify/OrderIdentity/${orderId}`,
        placement: "thank_you",
        locale: "en",
        country: "US",
        isFirstOrder: true,
        answers: [{ questionId: question.id, optionIds: [option!.id] }],
      }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; counted: boolean };
}

async function order(orderId: string, total: string, currency: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await processWebhook({
    topic: "orders/create",
    shopDomain: DOMAIN,
    payload: { id: Number(orderId), name: `#${orderId.slice(-4)}`, currency, current_total_price: total, financial_status: "paid", test: false, created_at: now, updated_at: now, ...extra },
    accessToken: null,
  });
}

beforeAll(async () => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/980001" })).id;
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "growth", planStatus: "active" } });
  await seedOfflineSession(DOMAIN);
  clearConfigCache();
  clearShopDisplayCache();
  resetBuckets();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  await prisma.$disconnect();
});

describe("a store from install to reports", () => {
  it("creates a live survey with the quick start", async () => {
    stubShopify();
    const res = await runRoute(
      quickStartAction as never,
      adminForm(DOMAIN, "/app/surveys/quick-start", {
        choice: JSON.stringify({ country: "US", keys: ["instagram", "google", "friend_family"], custom: [], allowOther: true, followUp: false }),
      }),
    ).catch((thrown: unknown) => thrown);
    expect(res).toBeInstanceOf(Response);
    const location = (res as Response).headers.get("Location") ?? "";
    expect(location).toMatch(/^\/app\/surveys\/[^?]+\?launched=1/);
    surveyId = location.split("/").pop()!.split("?")[0]!;
    const row = await prisma.survey.findUniqueOrThrow({ where: { id: surveyId } });
    expect(row.status).toBe("active");
  });

  it("stores answers before and after their orders, once per order", async () => {
    stubShopify();
    const labels = (await loadConfig("5000000000001")).survey!.questions[0]!.options.map((o) => o.label);
    const instagram = labels.find((l) => /instagram/i.test(l))!;
    const google = labels.find((l) => /google/i.test(l))!;

    await order("5000000000001", "40.00", "USD");
    expect((await answer("5000000000001", instagram)).counted).toBe(true);
    // Answer first, order later (the Thank-you page usually beats the webhook).
    await answer("5000000000002", instagram);
    await order("5000000000002", "60.00", "USD");
    await answer("5000000000003", google);
    await order("5000000000003", "5000", "JPY");
    await answer("5000000000004", google);
    await order("5000000000004", "1.234", "KWD");
    // A test order and a fully refunded one: counted as answers, not revenue.
    await answer("5000000000005", google);
    await order("5000000000005", "99.00", "USD", { test: true });
    await answer("5000000000006", instagram);
    await order("5000000000006", "0.00", "USD", { financial_status: "refunded" });
    // A second answer for an order already answered is a duplicate.
    const again = await loadConfig("5000000000001");
    expect(again.alreadyAnswered).toBe(true);

    expect(await prisma.response.count({ where: { shopId } })).toBe(6);
  });

  it("reports the same numbers on every screen", async () => {
    stubShopify();
    const channels = (await runRoute(dashboardLoader as never, adminRequest(DOMAIN, "/app/dashboard?range=30"))) as {
      summary: { totalResponses: number; revenue: Array<{ currency: string; text: string }>; aov: Array<{ currency: string; text: string }> };
      channels: Array<{ label: string | null; responses: number; revenue: Array<{ currency: string; text: string }> }>;
    };
    expect(channels.summary.totalResponses).toBe(6);
    const revenue = Object.fromEntries(channels.summary.revenue.map((r) => [r.currency, r.text.replace(/\s/g, " ")]));
    expect(revenue).toEqual({ JPY: "¥5,000", KWD: "KWD 1.234", USD: "$100.00" });
    const aov = Object.fromEntries(channels.summary.aov.map((r) => [r.currency, r.text]));
    expect(aov.USD).toBe("$50.00");

    const home = (await runRoute(homeLoader as never, adminRequest(DOMAIN, "/app?range=30"))) as {
      dashboard: { kpis?: unknown } | null;
    };
    expect(home.dashboard).not.toBeNull();
    const homeText = JSON.stringify(home.dashboard);
    expect(homeText).toContain("$100.00");
    expect(homeText).toContain("¥5,000");

    const results = (await runRoute(resultsLoader as never, adminRequest(DOMAIN, `/app/results?survey=${surveyId}&range=30`))) as Record<string, unknown>;
    expect(JSON.stringify(results)).toContain("$100.00");

    const responses = (await runRoute(responsesLoader as never, adminRequest(DOMAIN, `/app/responses?survey=${surveyId}`))) as { rows: unknown[] };
    expect(responses.rows).toHaveLength(6);

    const allCsv = await (await runRoute(exportCsvLoader as never, adminRequest(DOMAIN, "/app/export/csv?survey=all"))) as Response;
    const allText = await allCsv.text();
    expect(allText.split("\n").filter((l) => l.trim()).length).toBe(1 + 6);
    expect(allText).toContain("1.234");
    expect(allText).toContain("5000");

    const surveyCsv = await (await runRoute(resultsCsvLoader as never, adminRequest(DOMAIN, `/app/results/csv?survey=${surveyId}`))) as Response;
    const surveyText = await surveyCsv.text();
    expect(surveyText.split("\n").filter((l) => l.trim()).length).toBe(1 + 6);
  });
});

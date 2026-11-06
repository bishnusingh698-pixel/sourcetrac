/**
 * Admin pages driven through the library's real `authenticate.admin`: an App
 * Bridge id token signed with the app secret and an offline session in
 * storage (`tests/helpers/admin-request.ts`). Only Shopify's Admin API is
 * stubbed, at `fetch`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { clearShopDisplayCache } from "~/lib/studio.server";
import { createSurvey } from "~/lib/surveys.server";
import { loader as homeLoader } from "~/routes/app._index";
import { loader as resultsLoader } from "~/routes/app.results";
import { loader as responsesLoader } from "~/routes/app.responses";
import { loader as resultsCsvLoader } from "~/routes/app.results_.csv";
import { adminRequest, runRoute, seedOfflineSession } from "./helpers/admin-request";

const prisma = new PrismaClient();
const DOMAIN = "admin-routes-test.myshopify.com";
const OTHER = "admin-routes-other.myshopify.com";
let shopId = "";

/** Shopify answers every Admin query with an empty shop. */
function stubAdminApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: { shop: { ianaTimezone: "Europe/Berlin", shopAddress: { countryCodeV2: "DE" } } } }), { status: 200 })),
  );
}

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: { in: [DOMAIN, OTHER] } } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/970001" })).id;
  await seedOfflineSession(DOMAIN);
  clearShopDisplayCache();
  stubAdminApi();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: { in: [DOMAIN, OTHER] } } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  await prisma.$disconnect();
});

describe("Home", () => {
  it("names templates in the admin's language when the merchant never picked one", async () => {
    // Shopify's admin is in German and the merchant never chose a language:
    // the page is German, so the template name inside its sentence must be too.
    await prisma.shop.update({ where: { id: shopId }, data: { language: null, adminLocale: "de" } });
    const data = (await runRoute(homeLoader as never, adminRequest(DOMAIN, "/app"))) as { channelCompassName: string };
    expect(data.channelCompassName).toBe("Wie sind Sie auf uns aufmerksam geworden?");
  });
});

describe("per-shop isolation", () => {
  it("never serves another shop's survey named in the URL", async () => {
    const otherId = (await upsertShop({ shopDomain: OTHER, shopId: "gid://shopify/Shop/970002" })).id;
    const survey = (input: string) => ({
      name: input,
      status: "draft" as const,
      placements: ["thank_you" as const],
      layout: "all" as const,
      title: input,
      intro: null,
      buttonLabel: "Submit",
      thankYouText: "Thanks",
      questions: [{ type: "single_choice" as const, text: `${input}?`, options: [{ label: "A" }, { label: "B" }] }],
    });
    const theirs = await createSurvey(otherId, survey("Their survey"));
    const mine = await createSurvey(shopId, survey("My survey"));

    const results = (await runRoute(resultsLoader as never, adminRequest(DOMAIN, `/app/results?survey=${theirs.id}`))) as { selected: string | null };
    expect(results.selected).toBe(mine.id);
    const responses = (await runRoute(responsesLoader as never, adminRequest(DOMAIN, `/app/responses?survey=${theirs.id}`))) as { selected: string | null };
    expect(responses.selected).toBe(mine.id);
    const csv = (await runRoute(resultsCsvLoader as never, adminRequest(DOMAIN, `/app/results/csv?survey=${theirs.id}`))) as Response;
    expect(await csv.text()).not.toContain("Their survey");
  });
});

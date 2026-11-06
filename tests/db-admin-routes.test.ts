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
import { loader as homeLoader } from "~/routes/app._index";
import { adminRequest, runRoute, seedOfflineSession } from "./helpers/admin-request";

const prisma = new PrismaClient();
const DOMAIN = "admin-routes-test.myshopify.com";
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
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/970001" })).id;
  await seedOfflineSession(DOMAIN);
  clearShopDisplayCache();
  stubAdminApi();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
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

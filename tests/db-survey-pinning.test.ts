/**
 * A checkout block's "Survey ID" setting, and what the checkout editor shows,
 * driven through the real routes with a signed session token against Postgres.
 *
 * Before this, a merchant with several surveys could not tell which one a block
 * would show, and the editor always drew a fixed sample question.
 *  - A pinned block shows that survey, or nothing when it is not live: a
 *    paused survey must not be silently replaced by another one.
 *  - An id that names no survey of this shop falls back to the normal pick, so
 *    a stale setting never empties the page and never reaches another shop.
 *  - The editor preview shows the named survey whatever its status, and the
 *    normal pick without a setting.
 */
import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache, createSurvey, type SurveyInput } from "~/lib/surveys.server";
import { loader as surveyLoader } from "~/routes/api.survey";
import { loader as previewLoader, type SurveyPreviewBody } from "~/routes/api.survey-preview";

const prisma = new PrismaClient();
const DOMAIN = "survey-pinning-test.myshopify.com";
const OTHER_DOMAIN = "survey-pinning-other.myshopify.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const ORDER = encodeURIComponent("gid://shopify/OrderIdentity/7420000000001");

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

async function get<T>(handler: (args: { request: Request }) => Promise<Response>, path: string): Promise<T> {
  const request = new Request(`https://sourcetrac.test${path}`, {
    headers: { Authorization: `Bearer ${sessionToken()}`, Origin: "https://extensions.shopifycdn.com", "User-Agent": UA },
  });
  let res: Response;
  try {
    res = await handler({ request });
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    res = thrown;
  }
  expect(res.status).toBe(200);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  return (await res.json()) as T;
}

type ConfigBody = { enabled: boolean; survey: { id: string } | null };

function input(name: string, over: Partial<SurveyInput> = {}): SurveyInput {
  return {
    name,
    status: "active",
    placements: ["thank_you"],
    layout: "all",
    title: name,
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      {
        type: "single_choice",
        text: `${name} question`,
        required: true,
        randomizeOptions: false,
        allowOther: false,
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
    ...over,
  };
}

let first = "";
let second = "";
let paused = "";
let draft = "";
let thankYouOnly = "";
let foreign = "";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: { in: [DOMAIN, OTHER_DOMAIN] } } });
  clearConfigCache();

  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9700001" });
  // Several live surveys are a paid feature.
  await prisma.shop.update({ where: { id: shop.id }, data: { plan: "scale", planStatus: "active" } });
  first = (await createSurvey(shop.id, input("First", { priority: 10 }))).id;
  second = (await createSurvey(shop.id, input("Second", { priority: 1 }))).id;
  paused = (await createSurvey(shop.id, input("Paused", { status: "paused" }))).id;
  draft = (await createSurvey(shop.id, input("Draft", { status: "draft" }))).id;
  thankYouOnly = (await createSurvey(shop.id, input("Thank-you only", { placements: ["thank_you"] }))).id;

  const other = await upsertShop({ shopDomain: OTHER_DOMAIN, shopId: "gid://shopify/Shop/9700002" });
  foreign = (await createSurvey(other.id, input("Someone else's"))).id;
  clearConfigCache();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: { in: [DOMAIN, OTHER_DOMAIN] } } });
  await prisma.$disconnect();
});

describe("a block pinned to one survey", () => {
  it("shows the normal pick without a setting, and the same one in the editor", async () => {
    const config = await get<ConfigBody>(surveyLoader, `/api/survey?placement=thank_you&orderId=${ORDER}`);
    expect(config.enabled).toBe(true);
    const preview = await get<SurveyPreviewBody>(previewLoader, "/api/survey-preview?placement=thank_you");
    expect(preview).toMatchObject({ pinned: false, status: "active", reason: null, onThisPage: true });
    expect(preview.survey?.id).toBe(config.survey?.id);
  });

  it("shows the pinned survey instead of the normal pick", async () => {
    const normal = await get<ConfigBody>(surveyLoader, `/api/survey?placement=thank_you&orderId=${ORDER}`);
    const pinTo = normal.survey?.id === first ? second : first;
    // Pasted with spaces and capitals, as merchants do.
    const config = await get<ConfigBody>(
      surveyLoader,
      `/api/survey?placement=thank_you&orderId=${ORDER}&surveyId=${encodeURIComponent(` ${pinTo.toUpperCase()} `)}`,
    );
    expect(config.survey?.id).toBe(pinTo);
  });

  it("shows nothing when the pinned survey is paused or a draft, rather than another survey", async () => {
    for (const id of [paused, draft]) {
      const config = await get<ConfigBody>(surveyLoader, `/api/survey?placement=thank_you&orderId=${ORDER}&surveyId=${id}`);
      expect(config).toMatchObject({ enabled: false, survey: null });
    }
  });

  it("shows nothing on a page the pinned survey is not set for", async () => {
    const config = await get<ConfigBody>(
      surveyLoader,
      `/api/survey?placement=order_status&orderId=${ORDER}&surveyId=${thankYouOnly}`,
    );
    expect(config.enabled).toBe(false);
  });

  it("falls back to the normal pick for an unknown id, or another shop's", async () => {
    const normal = await get<ConfigBody>(surveyLoader, `/api/survey?placement=thank_you&orderId=${ORDER}`);
    for (const id of ["zzzzzzzzzzzzzzzzzzzzzzzzz", foreign, "not an id!"]) {
      const config = await get<ConfigBody>(
        surveyLoader,
        `/api/survey?placement=thank_you&orderId=${ORDER}&surveyId=${encodeURIComponent(id)}`,
      );
      expect(config.survey?.id).toBe(normal.survey?.id);
    }
  });
});

describe("the checkout editor preview", () => {
  it("shows a pinned draft with its status, so it can be checked before going live", async () => {
    const preview = await get<SurveyPreviewBody>(previewLoader, `/api/survey-preview?placement=thank_you&surveyId=${draft}`);
    expect(preview).toMatchObject({ name: "Draft", status: "draft", pinned: true, reason: null, onThisPage: true });
    expect(preview.survey?.questions[0]?.text).toBe("Draft question");
  });

  it("says when the pinned survey is not set for this page", async () => {
    const preview = await get<SurveyPreviewBody>(
      previewLoader,
      `/api/survey-preview?placement=order_status&surveyId=${thankYouOnly}`,
    );
    expect(preview).toMatchObject({ pinned: true, onThisPage: false });
  });

  it("never shows another shop's survey", async () => {
    const preview = await get<SurveyPreviewBody>(previewLoader, `/api/survey-preview?placement=thank_you&surveyId=${foreign}`);
    expect(preview).toMatchObject({ survey: null, pinned: true, reason: "not_found" });
  });

  it("says when no survey is live on the page", async () => {
    const preview = await get<SurveyPreviewBody>(previewLoader, "/api/survey-preview?placement=link");
    expect(preview).toMatchObject({ survey: null, pinned: false, reason: "none_live" });
  });
});

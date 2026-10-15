/**
 * Drafts for live surveys (S7), publish/discard, and the rotation and
 * payment-targeting selection (T11, T7) — against a real Postgres.
 *
 * The critical guarantees, each of which the code must not lose:
 *  - editing a LIVE survey does not change what shoppers see until publish,
 *  - publishing applies the draft, bumps the version and keeps option ids stable,
 *  - discarding leaves the published survey untouched,
 *  - rotation is deterministic per order id and the same on both surfaces,
 *  - an empty payment-type list hides a payment-gated survey.
 */
import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import {
  clearConfigCache,
  createSurvey,
  discardSurveyDraft,
  getCompiledConfig,
  getEditorSurvey,
  publishSurveyDraft,
  updateSurvey,
  type SurveyInput,
} from "~/lib/surveys.server";
import { loader as surveyLoader } from "~/routes/api.survey";

const prisma = new PrismaClient();
const DOMAIN = "studio-draft-test.myshopify.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

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

function request(path: string): Request {
  return new Request(`https://sourcetrac.test${path}`, {
    headers: {
      Authorization: `Bearer ${sessionToken()}`,
      Origin: "https://extensions.shopifycdn.com",
      "User-Agent": UA,
    },
  });
}

async function call(handler: (args: { request: Request }) => Promise<Response>, req: Request) {
  try {
    return await handler({ request: req });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function baseInput(over: Partial<SurveyInput> = {}): SurveyInput {
  return {
    name: "Price Pulse",
    status: "active",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      {
        type: "single_choice",
        text: "How did the price feel?",
        required: true,
        randomizeOptions: false,
        allowOther: false,
        options: [{ label: "A great deal" }, { label: "Fair" }],
      },
    ],
    ...over,
  };
}

let shopId = "";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  clearConfigCache();
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9500001", accessToken: null });
  shopId = shop.id;
  // Several live surveys, targeting rules and Shopify actions are paid features.
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("drafts for a live survey (S7)", () => {
  it("holds edits back until publish, then applies them", async () => {
    clearConfigCache();
    const survey = await createSurvey(shopId, baseInput());
    const publishedQuestionText = "How did the price feel?";

    // Edit the live survey: the change must be a draft, not live.
    const edited = baseInput({
      title: "A new title",
      questions: [
        {
          type: "single_choice",
          text: "Is the price fair?",
          required: true,
          randomizeOptions: false,
          allowOther: false,
          options: [{ label: "A great deal" }, { label: "Fair" }, { label: "Too high" }],
        },
      ],
    });
    await updateSurvey(shopId, survey.id, edited);

    // What shoppers see: the compiled config still has the OLD text.
    const live = await getCompiledConfig(shopId);
    const compiled = live.surveys.find((s) => s.id === survey.id)!;
    expect(compiled.title).toBe("Quick question");
    expect(compiled.questions[0]!.text).toBe(publishedQuestionText);

    // The editor sees the draft.
    const editor = await getEditorSurvey(shopId, survey.id);
    expect(editor.hasDraft).toBe(true);
    expect(editor.draftUpdatedAt).not.toBeNull();
    expect(editor.title).toBe("A new title");
    expect(editor.questions[0]!.text).toBe("Is the price fair?");
    expect(editor.questions[0]!.options.length).toBe(3);

    // Publish applies it and bumps the version.
    const versionBefore = survey.version;
    const published = await publishSurveyDraft(shopId, survey.id);
    expect(published.hasDraft).toBe(false);
    expect(published.version).toBe(versionBefore + 1);

    clearConfigCache();
    const liveAfter = await getCompiledConfig(shopId);
    const compiledAfter = liveAfter.surveys.find((s) => s.id === survey.id)!;
    expect(compiledAfter.title).toBe("A new title");
    expect(compiledAfter.questions[0]!.text).toBe("Is the price fair?");
  });

  it("keeps option ids stable across a publish", async () => {
    const survey = await createSurvey(shopId, baseInput({ name: "Stable ids" }));
    const before = await getEditorSurvey(shopId, survey.id);
    const keptQuestionId = before.questions[0]!.id;
    const keptOptionId = before.questions[0]!.options[0]!.id;

    // Change a label and add one option, then publish. The editor posts the
    // existing question and option ids back, so both are matched and kept.
    await updateSurvey(shopId, survey.id, baseInput({
      name: "Stable ids",
      questions: [
        {
          id: keptQuestionId,
          type: "single_choice",
          text: "How did the price feel?",
          required: true,
          randomizeOptions: false,
          allowOther: false,
          options: [
            { id: keptOptionId, label: "A great deal (reworded)" },
            { label: "Fair" },
            { label: "Too high" },
          ],
        },
      ],
    }));
    await publishSurveyDraft(shopId, survey.id);

    const after = await getEditorSurvey(shopId, survey.id);
    expect(after.questions[0]!.options[0]!.id).toBe(keptOptionId);
    expect(after.questions[0]!.options[0]!.label).toBe("A great deal (reworded)");
  });

  it("discards a draft without touching the published survey", async () => {
    const survey = await createSurvey(shopId, baseInput({ name: "Discard me" }));
    await updateSurvey(shopId, survey.id, baseInput({ name: "Discard me", title: "Changed but thrown away" }));
    const beforeDiscard = await getEditorSurvey(shopId, survey.id);
    expect(beforeDiscard.hasDraft).toBe(true);

    await discardSurveyDraft(shopId, survey.id);
    const after = await getEditorSurvey(shopId, survey.id);
    expect(after.hasDraft).toBe(false);
    expect(after.title).toBe("Quick question");
  });
});

describe("concurrency conflict detection (section 6.6)", () => {
  it("refuses a save whose revision is stale", async () => {
    const survey = await createSurvey(shopId, baseInput({ name: "Concurrency" }));
    const loaded = await getEditorSurvey(shopId, survey.id);
    const staleRevision = loaded.revision;

    // Window B saves first, moving the revision.
    await updateSurvey(shopId, survey.id, baseInput({ name: "Concurrency", title: "B saved" }), staleRevision);

    // Window A, still holding the old revision, is refused rather than
    // clobbering B's save.
    await expect(
      updateSurvey(shopId, survey.id, baseInput({ name: "Concurrency", title: "A saved" }), staleRevision),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });

    // B's save stands.
    const after = await getEditorSurvey(shopId, survey.id);
    expect(after.title).toBe("B saved");
  });

  it("accepts a save whose revision is current", async () => {
    const survey = await createSurvey(shopId, baseInput({ name: "Fresh" }));
    const loaded = await getEditorSurvey(shopId, survey.id);
    const saved = await updateSurvey(
      shopId,
      survey.id,
      baseInput({ name: "Fresh", title: "Saved fine" }),
      loaded.revision,
    );
    expect(saved.title).toBe("Saved fine");
    // The token moved so the next window holding the old value is refused.
    expect(saved.revision).toBeGreaterThan(loaded.revision);
  });

  it("refuses a publish whose revision is stale", async () => {
    const survey = await createSurvey(shopId, baseInput({ name: "Publish conflict" }));
    const loaded = await getEditorSurvey(shopId, survey.id);
    await updateSurvey(shopId, survey.id, baseInput({ name: "Publish conflict", title: "draft" }), loaded.revision);

    await expect(publishSurveyDraft(shopId, survey.id, loaded.revision)).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
  });

  it("does not move the revision when a response is counted", async () => {
    // The editor's token must not be invalidated by shoppers answering, or
    // every active survey would report a false conflict. `revision` is bumped
    // only by merchant writes, unlike `updatedAt`.
    const survey = await createSurvey(shopId, baseInput({ name: "No false conflict" }));
    const loaded = await getEditorSurvey(shopId, survey.id);
    await prisma.survey.update({
      where: { id: survey.id },
      data: { responseCount: { increment: 1 } },
    });
    const after = await getEditorSurvey(shopId, survey.id);
    expect(after.revision).toBe(loaded.revision);
    // And the loaded token still saves cleanly.
    await expect(
      updateSurvey(shopId, survey.id, baseInput({ name: "No false conflict", title: "still fine" }), loaded.revision),
    ).resolves.toBeTruthy();
  });
});

describe("rotation and payment targeting through the config route (T11, T7)", () => {
  it("picks the same rotation member for a given order on the thank-you surface", async () => {
    clearConfigCache();
    await createSurvey(shopId, baseInput({ name: "Rot A", rotation: true, rotationWeight: 1, priority: 1 }));
    await createSurvey(shopId, baseInput({ name: "Rot B", rotation: true, rotationWeight: 1, priority: 1 }));

    const orderId = "gid://shopify/OrderIdentity/5555000000001";
    const first = (await (await call(surveyLoader, request(`/api/survey?placement=thank_you&orderId=${encodeURIComponent(orderId)}`))).json()) as {
      survey: { id: string } | null;
    };
    const second = (await (await call(surveyLoader, request(`/api/survey?placement=thank_you&orderId=${encodeURIComponent(orderId)}`))).json()) as {
      survey: { id: string } | null;
    };
    expect(first.survey?.id).toBe(second.survey?.id);
    expect(first.survey).not.toBeNull();
  });

  it("hides a payment-gated survey when the payment list is empty, shows it for manual", async () => {
    clearConfigCache();
    // Isolate: pause every other survey so only the payment-gated one can match.
    await prisma.survey.updateMany({ where: { shopId }, data: { status: "paused" } });
    const survey = await createSurvey(shopId, baseInput({ name: "Delivery Ready" }));
    await prisma.survey.update({
      where: { id: survey.id },
      data: { targeting: JSON.stringify({ paymentManualOnly: true }) },
    });
    clearConfigCache();

    const orderId = encodeURIComponent("gid://shopify/OrderIdentity/5555000000002");

    // Empty payment list -> not shown (the safe failure for the offsite case).
    const empty = (await (await call(surveyLoader, request(`/api/survey?placement=thank_you&orderId=${orderId}`))).json()) as { enabled: boolean };
    expect(empty.enabled).toBe(false);

    // A card payment -> not shown.
    const card = (await (await call(surveyLoader, request(`/api/survey?placement=thank_you&orderId=${orderId}&paymentTypes=creditCard`))).json()) as { enabled: boolean };
    expect(card.enabled).toBe(false);

    // A manual payment -> shown.
    const manual = (await (await call(surveyLoader, request(`/api/survey?placement=thank_you&orderId=${orderId}&paymentTypes=manualPayment`))).json()) as { enabled: boolean };
    expect(manual.enabled).toBe(true);
  });
});

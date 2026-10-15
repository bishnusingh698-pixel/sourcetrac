/**
 * DH-002: the template plan lock is enforced by the server, not just hidden in
 * the gallery. A Free shop cannot create a survey that uses a Growth-only
 * feature (an exclusive option, T6, or a by-product breakdown, T8) by posting a
 * crafted request; a paid shop can. Editing a survey to ADD an exclusive option
 * is blocked on Free too, while an existing one is grandfathered.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { upsertShop, setPlan } from "~/lib/shop.server";
import { createSurvey, getSurveyRow, publishSurveyDraft, updateSurvey, type SurveyInput } from "~/lib/surveys.server";

const prisma = new PrismaClient();
const DOMAIN = "template-plan-test.myshopify.com";
const GID = "gid://shopify/Shop/9500101";

let shopId = "";

function exclusiveInput(over: Partial<SurveyInput> = {}): SurveyInput {
  return {
    name: "Recall",
    status: "draft",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    templateId: "ad-recall",
    questions: [
      {
        type: "multi_choice",
        text: "Where did you hear about us?",
        required: false,
        randomizeOptions: false,
        allowOther: false,
        options: [
          { label: "Instagram" },
          { label: "Nowhere", exclusive: true },
        ],
      },
    ],
    ...over,
  };
}

function byProductInput(): SurveyInput {
  return {
    name: "Deciding",
    status: "draft",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    templateId: "deciding-detail",
    questions: [
      {
        type: "single_choice",
        text: "What tipped your decision?",
        required: true,
        randomizeOptions: false,
        allowOther: false,
        options: [{ label: "Reviews" }, { label: "Price" }],
      },
    ],
  };
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: GID, accessToken: null });
  shopId = shop.id;
});

describe("template plan enforcement (DH-002)", () => {
  it("rejects an exclusive-option create on Free", async () => {
    await expect(createSurvey(shopId, exclusiveInput())).rejects.toMatchObject({ code: "validation_failed", fields: { code: "template_plan_locked" } });
  });

  it("allows the same create on Growth", async () => {
    await setPlan(shopId, { plan: "growth", planStatus: "active", subscriptionGid: null });
    const survey = await createSurvey(shopId, exclusiveInput());
    expect(survey.id).toBeTruthy();
  });

  it("rejects a by-product template create on Free", async () => {
    await expect(createSurvey(shopId, byProductInput())).rejects.toMatchObject({ code: "validation_failed", fields: { code: "template_plan_locked" } });
  });

  it("does not gate a plain survey with no template", async () => {
    const survey = await createSurvey(shopId, {
      ...exclusiveInput(),
      templateId: null,
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
    expect(survey.id).toBeTruthy();
  });

  it("blocks ADDING an exclusive option on Free but grandfathers an existing one", async () => {
    // Created on Growth, then the shop downgrades.
    await setPlan(shopId, { plan: "growth", planStatus: "active", subscriptionGid: null });
    const survey = await createSurvey(shopId, exclusiveInput());
    await setPlan(shopId, { plan: "free", planStatus: "cancelled", subscriptionGid: null });

    const row = await getSurveyRow(shopId, survey.id);
    expect(row).not.toBeNull();
    // Editing while keeping the exclusive option is allowed (grandfathered).
    await expect(
      updateSurvey(shopId, survey.id, exclusiveInput({ name: "Still works" })),
    ).resolves.toBeTruthy();

    // A fresh Free survey with no exclusive option cannot gain one.
    const plain = await createSurvey(shopId, {
      ...exclusiveInput(),
      templateId: null,
      questions: [
        {
          type: "multi_choice",
          text: "Pick",
          required: false,
          randomizeOptions: false,
          allowOther: false,
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    });
    const withExclusive: SurveyInput = {
      ...exclusiveInput(),
      templateId: null,
      questions: [
        {
          type: "multi_choice",
          text: "Pick",
          required: false,
          randomizeOptions: false,
          allowOther: false,
          options: [{ label: "A" }, { label: "B", exclusive: true }],
        },
      ],
    };
    await expect(updateSurvey(shopId, plain.id, withExclusive)).rejects.toMatchObject({ code: "validation_failed", fields: { code: "template_plan_locked" } });
  });

  it("blocks publishing a draft that added the exclusive option after a downgrade", async () => {
    // Live on Growth without the exclusive option; add it in a draft while
    // still on Growth, then downgrade and try to publish.
    await setPlan(shopId, { plan: "growth", planStatus: "active", subscriptionGid: null });
    const plainInput: SurveyInput = {
      ...exclusiveInput(),
      templateId: null,
      status: "active",
      questions: [
        {
          type: "multi_choice",
          text: "Pick",
          required: false,
          randomizeOptions: false,
          allowOther: false,
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    };
    const survey = await createSurvey(shopId, plainInput);
    const withExclusive: SurveyInput = {
      ...plainInput,
      questions: [
        {
          type: "multi_choice",
          text: "Pick",
          required: false,
          randomizeOptions: false,
          allowOther: false,
          options: [{ label: "A" }, { label: "B", exclusive: true }],
        },
      ],
    };
    await updateSurvey(shopId, survey.id, withExclusive); // live -> stored as draft
    await setPlan(shopId, { plan: "free", planStatus: "cancelled", subscriptionGid: null });

    await expect(publishSurveyDraft(shopId, survey.id)).rejects.toMatchObject({
      code: "validation_failed",
      fields: { code: "template_plan_locked" },
    });
  });
});

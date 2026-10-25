/**
 * F4: an answer shown only to buyers in some countries. Stored, compiled into
 * the checkout config, hidden by the block for buyers elsewhere, a Growth rule
 * like the survey's own country list (kept after a downgrade, never added on
 * Free), and refused when a code is not a country.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import {
  clearConfigCache,
  createSurvey,
  getCompiledConfig,
  getEditorSurvey,
  updateSurvey,
  type EditorSurvey,
  type SurveyInput,
} from "~/lib/surveys.server";
import { ValidationError } from "~/lib/errors";
import { optionsForCountry } from "../extensions/shared/src/survey-logic";

const prisma = new PrismaClient();
const DOMAIN = "answer-countries-test.myshopify.com";
let shopId = "";

function input(countries: string[] | undefined): SurveyInput {
  return {
    name: "Countries",
    status: "draft",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      {
        type: "single_choice",
        text: "Where did you hear about us?",
        required: true,
        options: [{ label: "Instagram" }, { label: "Google" }, { label: "LINE", ...(countries ? { countries } : {}) }],
      },
    ],
  };
}

/** The editor's own payload for a saved survey, with one change. */
function edit(survey: EditorSurvey, countries: string[]): SurveyInput {
  return {
    ...survey,
    questions: survey.questions.map((q) => ({
      ...q,
      options: q.options.map((o) => (o.label === "LINE" ? { ...o, countries } : o)),
    })),
  } as unknown as SurveyInput;
}

async function setPlan(plan: "free" | "growth" | "scale") {
  await prisma.shop.update({ where: { id: shopId }, data: { plan, planStatus: "active" } });
  clearConfigCache();
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return String(error.fields.code ?? error.code);
    throw error;
  }
}

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9850001" })).id;
  clearConfigCache();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("answers limited to some countries (F4)", () => {
  it("stores the list, compiles it for the block, and leaves other answers without one", async () => {
    await setPlan("growth");
    const survey = await createSurvey(shopId, { ...input(["JP"]), status: "active" });
    const line = survey.questions[0]!.options.find((o) => o.label === "LINE")!;
    expect(line.countries).toEqual(["JP"]);

    const config = await getCompiledConfig(shopId);
    const options = config.surveys[0]!.questions[0]!.options;
    expect(options.find((o) => o.label === "LINE")?.countries).toEqual(["JP"]);
    // Unlimited answers carry no field, so configs stay as small as before.
    expect("countries" in options.find((o) => o.label === "Instagram")!).toBe(false);

    // What the block shows: LINE only for a buyer in Japan.
    expect(optionsForCountry(options, "US").map((o) => o.label)).toEqual(["Instagram", "Google"]);
    expect(optionsForCountry(options, "jp").map((o) => o.label)).toEqual(["Instagram", "Google", "LINE"]);
    // Unknown buyer country: every answer.
    expect(optionsForCountry(options, null)).toHaveLength(3);
  });

  it("never leaves a question with nothing to pick", () => {
    const options = [
      { id: "a", label: "A", isOther: false, countries: ["JP"] },
      { id: "b", label: "B", isOther: false, countries: ["KR"] },
    ];
    expect(optionsForCountry(options, "US")).toHaveLength(2);
  });

  it("is a Growth rule: refused on Free, kept after a downgrade", async () => {
    expect(await codeOf(createSurvey(shopId, input(["JP"])))).toBe("plan_advanced_targeting");

    await setPlan("growth");
    const survey = await createSurvey(shopId, input(["JP", "KR"]));
    await setPlan("free");
    // Unchanged or narrowed: allowed.
    const saved = await updateSurvey(shopId, survey.id, edit(await getEditorSurvey(shopId, survey.id), ["JP"]));
    expect(saved.questions[0]!.options.find((o) => o.label === "LINE")?.countries).toEqual(["JP"]);
    // Widened: refused.
    expect(
      await codeOf(updateSurvey(shopId, survey.id, edit(await getEditorSurvey(shopId, survey.id), ["JP", "TW"]))),
    ).toBe("plan_advanced_targeting");
  });

  it("refuses a code that is not a country", async () => {
    await setPlan("growth");
    expect(await codeOf(createSurvey(shopId, input(["UK"])))).toBe("invalid_country");
  });
});

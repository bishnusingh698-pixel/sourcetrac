import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { COLLECTED } from "~/components/data-notice";
import { createTranslator } from "~/lib/i18n";
import { PLANS, yearlySavingMinor } from "~/lib/plans";

/**
 * The privacy notice must say what is actually stored.
 *
 * Every column of the rows that describe a buyer's answer is classified below,
 * either as one of the groups the Privacy page lists or as internal bookkeeping
 * that says nothing about the buyer. A new column fails this test until someone
 * decides which it is, and updates the notice if it is buyer data.
 */

const ROOT = join(__dirname, "../..");
const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

function scalarFields(model: string): string[] {
  const body = schema.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m"))?.[1] ?? "";
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
    .map((line) => line.split(/\s+/))
    // Relations: a list type, or a field carrying @relation.
    .filter(([, type = "", ...rest]) => !type.endsWith("[]") && !rest.join(" ").includes("@relation"))
    .map(([name]) => name!);
}

/**
 * `unused`: a column that exists but nothing writes, so it is not listed as
 * collected. A test below fails the moment code starts filling it.
 */
type Group = (typeof COLLECTED)[number] | "internal" | "unused";

const CLASSIFIED: Record<string, Record<string, Group>> = {
  Response: {
    id: "internal",
    shopId: "internal",
    surveyId: "internal",
    surveyVersion: "internal",
    orderId: "order",
    customerId: "unused",
    orderTotal: "order",
    currency: "order",
    isFirstOrder: "context",
    productIds: "context",
    placement: "context",
    locale: "context",
    country: "context",
    flagged: "internal",
    verified: "internal",
    unverifiedFailed: "internal",
    createdAt: "context",
  },
  Answer: {
    id: "internal",
    shopId: "internal",
    responseId: "internal",
    questionId: "internal",
    optionIds: "answers",
    numberValue: "answers",
    textValue: "answers",
    otherText: "answers",
  },
  OrderCache: {
    id: "internal",
    shopId: "internal",
    orderId: "order",
    orderNumber: "order",
    currency: "order",
    totalPrice: "order",
    financialStatus: "order",
    isTest: "order",
    isCancelled: "order",
    cancelledAt: "order",
    createdAtShop: "order",
    updatedAtShop: "order",
    triggeredAt: "internal",
    createdAt: "internal",
    updatedAt: "internal",
  },
};

describe("privacy notice matches the schema", () => {
  for (const [model, fields] of Object.entries(CLASSIFIED)) {
    it(`classifies every ${model} column`, () => {
      expect(scalarFields(model).sort()).toEqual(Object.keys(fields).sort());
    });
  }

  it("lists every group a stored column belongs to", () => {
    const used = new Set(Object.values(CLASSIFIED).flatMap((fields) => Object.values(fields)));
    used.delete("internal");
    used.delete("unused");
    expect([...used].sort()).toEqual([...COLLECTED].sort());
  });

  it("never fills Response.customerId, which the notice does not list", () => {
    const writer = readFileSync(join(ROOT, "app/lib/answers.server.ts"), "utf8");
    expect(writer).toContain("tx.response.create(");
    expect(writer).not.toMatch(/customerId/);
  });

  it("stores no buyer contact field anywhere", () => {
    const contact = /^\s+(email|phone|firstName|lastName|address\w*|customerName)\s/im;
    for (const model of ["Response", "Answer", "OrderCache", "SurveyResponse"]) {
      const body = schema.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m"))?.[1] ?? "";
      expect(contact.test(body), model).toBe(false);
    }
  });

  it("renders real prose for every notice key", () => {
    const t = createTranslator("en");
    for (const key of COLLECTED) expect(t(`privacy.collect_${key}`)).not.toContain("privacy.");
    expect(t("privacy.notice", { months: 24 })).toContain("24 months");
  });

  it("shows the notice on every admin page, from the shell", () => {
    const shell = readFileSync(join(ROOT, "app/routes/app.tsx"), "utf8");
    expect(shell).toMatch(/<DataNotice\s+t=\{t\}\s+months=\{retentionMonths\}/);
    expect(shell).toContain("RECORD_RETENTION_DAYS");
  });
});

describe("yearly saving", () => {
  it("is twelve monthly payments minus the yearly price", () => {
    expect(yearlySavingMinor(PLANS.free)).toBe(0);
    expect(PLANS.growth.yearlyPriceMinor).toBe(5389);
    expect(yearlySavingMinor(PLANS.growth)).toBe(599);
    expect(PLANS.scale.yearlyPriceMinor).toBe(10789);
    expect(yearlySavingMinor(PLANS.scale)).toBe(1199);
  });

  it("never reports a negative saving", () => {
    expect(yearlySavingMinor({ priceMinor: 100, yearlyPriceMinor: 2000 })).toBe(0);
  });
});

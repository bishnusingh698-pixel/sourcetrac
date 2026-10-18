import { describe, expect, it } from "vitest";

import { templateById } from "@shared/templates";
import { buildSurveyDefinition } from "@shared/templates/resolve";
import { regionPackFor } from "@shared/templates/packs";
import {
  catalogPlanFromKey,
  definitionHasExclusiveOption,
  planIncludesGrowth,
  templateHasFreeVersion,
  templateLockedForPlan,
  templateRequiredPlan,
} from "@shared/templates/catalog";

/**
 * DH-002: the template plan lock must be a server rule, not just a hidden
 * button, and the Lite (Free) version must not carry the Growth-only feature.
 */
describe("template plan enforcement (DH-002)", () => {
  it("normalises stored plan values, unknown -> free", () => {
    expect(catalogPlanFromKey("growth")).toBe("growth");
    expect(catalogPlanFromKey("scale")).toBe("scale");
    expect(catalogPlanFromKey("free")).toBe("free");
    expect(catalogPlanFromKey(undefined)).toBe("free");
    expect(catalogPlanFromKey("enterprise")).toBe("free");
  });

  it("treats Growth and Scale as including the paid feature set", () => {
    expect(planIncludesGrowth("free")).toBe(false);
    expect(planIncludesGrowth("growth")).toBe(true);
    expect(planIncludesGrowth("scale")).toBe(true);
  });

  it("locks a Growth template on Free and unlocks it on Growth/Scale", () => {
    const adRecall = templateById("ad-recall")!;
    expect(templateRequiredPlan(adRecall)).toBe("growth");
    expect(templateLockedForPlan(adRecall, "free")).toBe(true);
    expect(templateLockedForPlan(adRecall, "growth")).toBe(false);
    expect(templateLockedForPlan(adRecall, "scale")).toBe(false);
  });

  it("does not lock a Free template", () => {
    const compass = templateById("channel-compass")!;
    expect(templateRequiredPlan(compass)).toBe("free");
    expect(templateLockedForPlan(compass, "free")).toBe(false);
  });

  it("keeps the None answer in the Lite version, without the paid clear-the-rest behaviour", () => {
    // An exclusive option (T6) is what makes the FULL template Growth. If Lite
    // kept it, a Free merchant would get the paid feature.
    for (const id of ["ad-recall", "packaging-priorities", "taste-profile", "where-else", "contact-preference"]) {
      const template = templateById(id)!;
      expect(templateRequiredPlan(template)).toBe("growth");

      const full = buildSurveyDefinition({ template, locale: "en", region: regionPackFor("US"), lite: false });
      const lite = buildSurveyDefinition({ template, locale: "en", region: regionPackFor("US"), lite: true });

      expect(definitionHasExclusiveOption(full)).toBe(true);
      expect(definitionHasExclusiveOption(lite)).toBe(false);
      // Every answer survives, "None of these" included: without it a buyer
      // with nothing to tick had to pick something untrue.
      const fullQuestion = full.questions.find((q) => q.options?.some((o) => o.exclusive))!;
      const liteQuestion = lite.questions.find((q) => q.id === fullQuestion.id)!;
      expect(liteQuestion.options!.map((o) => o.id)).toEqual(fullQuestion.options!.map((o) => o.id));
    }
  });

  it("has no Free version when the by-product breakdown cannot be subset away", () => {
    // deciding-detail and price-pulse gate on the T8 by-product breakdown, which
    // is a results feature tied to the template id. Lite keeps it, so it must
    // NOT be offered as a Free version.
    for (const id of ["deciding-detail", "price-pulse"]) {
      const template = templateById(id)!;
      expect(template.resultsHints?.byProduct).toBe(true);
      expect(templateHasFreeVersion(template)).toBe(false);
    }
    // An exclusive-only gate DOES have a Free version (Lite strips it).
    expect(templateHasFreeVersion(templateById("ad-recall")!)).toBe(true);
  });
});


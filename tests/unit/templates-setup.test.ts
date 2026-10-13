import { describe, expect, it } from "vitest";

import { buildWizardSyncOptions, buildWizardTargeting } from "@shared/templates/setup";
import { TEMPLATES, templateById } from "@shared/templates";
import { LIMITS } from "@shared/survey-rules";

describe("quick setup targeting", () => {
  it("keeps an empty targeting when nothing is set", () => {
    expect(buildWizardTargeting({ audience: "everyone", samplePercent: 100 })).toEqual({});
  });

  it("maps audience, sample and payment flags", () => {
    const targeting = buildWizardTargeting({
      audience: "returning",
      samplePercent: 40,
      paymentManualOnly: true,
    });
    expect(targeting).toEqual({ customerType: "returning", samplePercent: 40, paymentManualOnly: true });
  });

  it("only sends product targeting when the toggle is on and an id is present", () => {
    // Toggle off → no productIds even if the merchant typed them in the field.
    expect(buildWizardTargeting({ productsOnly: false, productIds: ["1", "2"] })).toEqual({});
    expect(buildWizardTargeting({ productsOnly: true, productIds: [] })).toEqual({});
    expect(buildWizardTargeting({ productsOnly: true, productIds: ["1", "2"] })).toEqual({
      productIds: ["1", "2"],
    });
  });

  it("caps product ids at the limit", () => {
    const many = Array.from({ length: LIMITS.MAX_TARGET_PRODUCTS + 5 }, (_, i) => String(i));
    const targeting = buildWizardTargeting({ productsOnly: true, productIds: many });
    expect(targeting.productIds).toHaveLength(LIMITS.MAX_TARGET_PRODUCTS);
  });
});

describe("quick setup smart actions", () => {
  it("returns nothing when no smart action is enabled", () => {
    const template = templateById("channel-compass")!;
    expect(buildWizardSyncOptions(template, {})).toEqual({});
    expect(buildWizardSyncOptions(template, { smartActions: [] })).toEqual({});
  });

  it("keeps the tag name template so each answer gets its own tag", () => {
    const template = templateById("delivery-ready")!;
    const sync = buildWizardSyncOptions(template, { smartActions: ["delivery_status_order_tag"] }) as {
      orderTags?: string[];
      presets?: string[];
    };
    // The literal `{optionKey}` placeholder must survive, not be replaced with a
    // fixed value, or every order would carry the same tag.
    expect(sync.orderTags).toContain("delivery-check:{optionKey}");
    expect(sync.presets).toEqual(["delivery_status_order_tag"]);
  });

  it("ignores a preset id that the template does not offer", () => {
    const template = templateById("channel-compass")!;
    // `fit_unsure_order_tag` belongs to a different template.
    const sync = buildWizardSyncOptions(template, { smartActions: ["fit_unsure_order_tag"] }) as {
      orderTags?: string[];
    };
    expect(sync.orderTags).toBeUndefined();
  });

  it("offers only presets that exist in the dictionary for every template", () => {
    for (const template of TEMPLATES) {
      for (const id of template.smartActions ?? []) {
        const sync = buildWizardSyncOptions(template, { smartActions: [id] }) as { presets?: string[] };
        expect(sync.presets, `${template.id}/${id}`).toContain(id);
      }
    }
  });
});

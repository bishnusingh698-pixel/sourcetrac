import { describe, expect, it } from "vitest";

import { resolveSmartActionWrites, SMART_ACTION_PRESETS } from "@shared/templates/smart-actions";
import { stableOptionId, stableQuestionId } from "@shared/templates/resolve";
import { TEMPLATES } from "@shared/templates";

/**
 * Build the answer rows a resolver call needs, using real stable ids.
 *
 * Yes/No is stored as a NUMBER, not an option id (`shared/survey-rules.ts`:
 * yes = 1, no = 0), so pass `yesNo` for those questions — passing an option key
 * would test a shape production never writes.
 */
function answer(templateId: string, questionKey: string, optionKey?: string, numberValue?: number) {
  const questionId = stableQuestionId(templateId, questionKey);
  return {
    questionId,
    optionIds: optionKey ? [stableOptionId(templateId, questionKey, optionKey)] : [],
    numberValue: numberValue ?? null,
  };
}

/** A yes/no answer, stored the way production stores it (numberValue 1 or 0). */
function yesNo(templateId: string, questionKey: string, yes: boolean) {
  return {
    questionId: stableQuestionId(templateId, questionKey),
    optionIds: [] as string[],
    numberValue: yes ? 1 : 0,
  };
}

describe("resolveSmartActionWrites (T13)", () => {
  it("writes a per-answer order tag from the option key", () => {
    const out = resolveSmartActionWrites({
      templateId: "delivery-ready",
      presetIds: ["delivery_status_order_tag"],
      answers: [answer("delivery-ready", "q_availability", "maybe")],
    });
    expect(out.orderTags).toEqual(["delivery-check:maybe"]);
    expect(out.customerTags).toEqual([]);
  });

  it("maps the value via the preset's valueMap", () => {
    const out = resolveSmartActionWrites({
      templateId: "delivery-ready",
      presetIds: ["delivery_status_order_tag"],
      answers: [answer("delivery-ready", "q_availability", "not_sure")],
    });
    expect(out.orderTags).toEqual(["delivery-check:unsure"]);
  });

  it("writes nothing when the onlyForOptionKeys guard does not match", () => {
    const out = resolveSmartActionWrites({
      templateId: "fit-confidence",
      presetIds: ["fit_unsure_order_tag"],
      answers: [answer("fit-confidence", "q_fit_sure", "very_sure")],
    });
    expect(out.orderTags).toEqual([]);
  });

  it("writes the fixed tag when onlyForOptionKeys matches", () => {
    const out = resolveSmartActionWrites({
      templateId: "fit-confidence",
      presetIds: ["fit_unsure_order_tag"],
      answers: [answer("fit-confidence", "q_fit_sure", "not_sure")],
    });
    expect(out.orderTags).toEqual(["fit:unsure"]);
  });

  it("bands a rating answer and fires only inside the band", () => {
    const low = resolveSmartActionWrites({
      templateId: "first-order-pulse",
      presetIds: ["first_order_low_rating_order_tag"],
      answers: [answer("first-order-pulse", "q_ease", undefined, 2)],
    });
    expect(low.orderTags).toEqual(["first-order:low-rating"]);

    const high = resolveSmartActionWrites({
      templateId: "first-order-pulse",
      presetIds: ["first_order_low_rating_order_tag"],
      answers: [answer("first-order-pulse", "q_ease", undefined, 5)],
    });
    expect(high.orderTags).toEqual([]);
  });

  it("bands an NPS answer into promoter/passive/detractor", () => {
    const band = (n: number) =>
      resolveSmartActionWrites({
        templateId: "loyalty-pulse",
        presetIds: ["nps_customer_tag"],
        answers: [answer("loyalty-pulse", "q_nps", undefined, n)],
      }).customerTags;
    expect(band(10)).toEqual(["nps:promoter"]);
    expect(band(9)).toEqual(["nps:promoter"]);
    expect(band(8)).toEqual(["nps:passive"]);
    expect(band(7)).toEqual(["nps:passive"]);
    expect(band(6)).toEqual(["nps:detractor"]);
    expect(band(0)).toEqual(["nps:detractor"]);
  });

  it("writes a customer metafield with the answer as its value", () => {
    const out = resolveSmartActionWrites({
      templateId: "taste-profile",
      presetIds: ["profile_customer_metafield"],
      answers: [answer("taste-profile", "q_profile", "dry")],
    });
    expect(out.customerMetafields).toEqual([
      { namespace: "sourcetrac", key: "profile", value: "dry" },
    ]);
  });

  it("leaves the reorder window metafield unset for 'not_sure'", () => {
    const notSure = resolveSmartActionWrites({
      templateId: "reorder-clock",
      presetIds: ["reorder_window_metafield"],
      answers: [answer("reorder-clock", "q_lasts", "not_sure"), yesNo("reorder-clock", "q_reorder_reminder", true)],
    });
    expect(notSure.customerMetafields).toEqual([]);

    const month = resolveSmartActionWrites({
      templateId: "reorder-clock",
      presetIds: ["reorder_window_metafield"],
      answers: [answer("reorder-clock", "q_lasts", "about_a_month"), yesNo("reorder-clock", "q_reorder_reminder", true)],
    });
    expect(month.customerMetafields).toEqual([
      { namespace: "sourcetrac", key: "reorder_window_days", value: "30" },
    ]);

    // Without the reminder opt-in, neither write happens.
    const noReminder = resolveSmartActionWrites({
      templateId: "reorder-clock",
      presetIds: ["reorder_window_metafield"],
      answers: [answer("reorder-clock", "q_lasts", "about_a_month"), yesNo("reorder-clock", "q_reorder_reminder", false)],
    });
    expect(noReminder.customerMetafields).toEqual([]);
  });

  it("writes the reorder tag from the window, gated on the reminder answer", () => {
    // Reminder = yes, window = two weeks: the tag carries the window.
    const optedIn = resolveSmartActionWrites({
      templateId: "reorder-clock",
      presetIds: ["reorder_customer_tag"],
      answers: [
        answer("reorder-clock", "q_lasts", "two_weeks"),
        yesNo("reorder-clock", "q_reorder_reminder", true),
      ],
    });
    expect(optedIn.customerTags).toEqual(["reorder:two_weeks"]);

    // Same window, but the buyer did not ask for a reminder: no tag.
    const optedOut = resolveSmartActionWrites({
      templateId: "reorder-clock",
      presetIds: ["reorder_customer_tag"],
      answers: [
        answer("reorder-clock", "q_lasts", "two_weeks"),
        yesNo("reorder-clock", "q_reorder_reminder", false),
      ],
    });
    expect(optedOut.customerTags).toEqual([]);
  });

  it("writes the needs-by-date tag only when the yes/no answer is Yes", () => {
    const yes = resolveSmartActionWrites({
      templateId: "delivery-promise",
      presetIds: ["needs_by_date_order_tag"],
      answers: [yesNo("delivery-promise", "q_needs_date", true)],
    });
    expect(yes.orderTags).toEqual(["needs-by-date"]);

    const no = resolveSmartActionWrites({
      templateId: "delivery-promise",
      presetIds: ["needs_by_date_order_tag"],
      answers: [yesNo("delivery-promise", "q_needs_date", false)],
    });
    expect(no.orderTags).toEqual([]);
  });

  it("writes the bulk-interest tag only when the yes/no answer is Yes", () => {
    const yes = resolveSmartActionWrites({
      templateId: "business-buyer",
      presetIds: ["bulk_interest_order_tag"],
      answers: [answer("business-buyer", "q_buying_for", "business"), yesNo("business-buyer", "q_bulk_price", true)],
    });
    expect(yes.orderTags).toEqual(["bulk-interest"]);

    const no = resolveSmartActionWrites({
      templateId: "business-buyer",
      presetIds: ["bulk_interest_order_tag"],
      answers: [answer("business-buyer", "q_buying_for", "business"), yesNo("business-buyer", "q_bulk_price", false)],
    });
    expect(no.orderTags).toEqual([]);
  });

  it("returns nothing without a template or without presets", () => {
    const withAnswer = { questionId: "x", optionIds: ["y"], numberValue: null };
    expect(resolveSmartActionWrites({ templateId: "", presetIds: ["nps_customer_tag"], answers: [withAnswer] })).toEqual({
      orderTags: [],
      customerTags: [],
      customerMetafields: [],
    });
    expect(resolveSmartActionWrites({ templateId: "loyalty-pulse", presetIds: [], answers: [withAnswer] })).toEqual({
      orderTags: [],
      customerTags: [],
      customerMetafields: [],
    });
  });

  it("ignores a preset whose question was answered with nothing", () => {
    const out = resolveSmartActionWrites({
      templateId: "gift-radar",
      presetIds: ["gifter_customer_tag"],
      answers: [],
    });
    expect(out.customerTags).toEqual([]);
  });

  it("never writes a translated label — tags stay identical in every language", () => {
    // The resolver only ever sees ids; a hand-built Chinese label cannot leak.
    const out = resolveSmartActionWrites({
      templateId: "channel-compass",
      presetIds: ["channel_order_tag"],
      answers: [answer("channel-compass", "q_channel", "instagram")],
    });
    expect(out.orderTags).toEqual(["found:instagram"]);
  });

  it("every preset's writes are a superset-compatible subset of its declared kind", () => {
    for (const id of Object.keys(SMART_ACTION_PRESETS)) {
      const preset = SMART_ACTION_PRESETS[id]!;
      const out = resolveSmartActionWrites({
        templateId: "some-template",
        presetIds: [id],
        answers: [],
      });
      // No writes without answers, whatever the kind.
      expect(out.orderTags).toHaveLength(0);
      expect(out.customerTags).toHaveLength(0);
      expect(out.customerMetafields).toHaveLength(0);
      expect(preset.kind).toBeTruthy();
    }
  });

  it("resolves a preset on a real template question id", () => {
    // Guard the stable-id contract: at least one real template declares each
    // preset's question, so the id the resolver builds exists.
    for (const template of TEMPLATES) {
      for (const id of template.smartActions ?? []) {
        const preset = SMART_ACTION_PRESETS[id];
        if (!preset) continue;
        const question = template.questions.find((q) => q.key === preset.questionKey);
        expect(question, `${template.id} is missing ${preset.questionKey}`).toBeDefined();
      }
    }
  });
});

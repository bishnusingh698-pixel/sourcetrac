import { describe, expect, it } from "vitest";

import {
  CATEGORY_ORDER,
  catalogCards,
  catalogDetail,
  currentSpotlight,
  filterCards,
  templatePlacements,
  templateRequiredPlan,
} from "@shared/templates/catalog";
import { TEMPLATES, templateById } from "@shared/templates";
import { TEMPLATE_BUNDLES } from "@shared/templates/locales";
import { TAG_EN, isTagId } from "@shared/templates/tags";
import { regionPackFor } from "@shared/templates/packs";

const base = { locale: "en", plan: "free" as const, country: "US", surveyLinkEnabled: false };

describe("template catalogue", () => {
  it("builds a card for every template, in the admin language", () => {
    const cards = catalogCards(base);
    const libraryTemplates = TEMPLATES.filter((t) => t.category !== "after_delivery");
    expect(cards).toHaveLength(libraryTemplates.length);
    for (const card of cards) {
      expect(card.name.length).toBeGreaterThan(0);
      expect(card.oneLiner.length).toBeGreaterThan(0);
      expect(card.tags.length).toBeGreaterThanOrEqual(1);
      expect(card.tags.length).toBeLessThanOrEqual(3);
    }
  });

  it("hides the After delivery category unless the survey link flag is on", () => {
    const off = catalogCards(base).map((c) => c.id);
    const on = catalogCards({ ...base, surveyLinkEnabled: true }).map((c) => c.id);
    expect(off).not.toContain("after-delivery");
    expect(on).toContain("after-delivery");
  });

  it("marks a template requiring an exclusive option as Growth", () => {
    // Ad Recall ships a "None of these" exclusive option.
    expect(templateRequiredPlan(templateById("ad-recall")!)).toBe("growth");
    // Channel Compass has no exclusive option and no by-product hint.
    expect(templateRequiredPlan(templateById("channel-compass")!)).toBe("free");
  });

  it("locks a Growth template on the Free plan but not on Growth", () => {
    const free = catalogCards(base).find((c) => c.id === "ad-recall")!;
    const growth = catalogCards({ ...base, plan: "growth" }).find((c) => c.id === "ad-recall")!;
    expect(free.planLocked).toBe(true);
    expect(free.requiredPlan).toBe("growth");
    expect(growth.planLocked).toBe(false);
  });

  it("searches name, one-liner and tag text", () => {
    const cards = catalogCards(base);
    // "gift" appears in the Gift Radar name.
    expect(filterCards(cards, { q: "gift" }).map((c) => c.id)).toContain("gift-radar");
    // "channels" appears in the best_channels tag text, not the Channel Compass name.
    expect(filterCards(cards, { q: "channels" }).map((c) => c.id)).toContain("channel-compass");
    // A nonsense word matches nothing.
    expect(filterCards(cards, { q: "zzzznope" })).toHaveLength(0);
  });

  it("filters by category, short and free", () => {
    const cards = catalogCards(base);
    expect(filterCards(cards, { category: "delivery" }).every((c) => c.category === "delivery")).toBe(true);
    expect(filterCards(cards, { shortOnly: true }).every((c) => c.isShort)).toBe(true);
    // "Works on Free plan" means the full version is unlocked AND a Lite exists.
    expect(filterCards(cards, { freeOnly: true }).every((c) => !c.planLocked && c.hasLite)).toBe(true);
  });

  it("filters 'popular here' by the shop's country", () => {
    const cards = catalogCards({ ...base, country: "US" });
    const popular = filterCards(cards, { popularHere: true, country: "US" });
    // An empty popularIn means "useful everywhere", so Delivery Ready Check
    // (popularIn empty) must appear for any country.
    expect(popular.map((c) => c.id)).toContain("delivery-ready");
    const other = filterCards(cards, { popularHere: true, country: "ZZ" });
    expect(other.map((c) => c.id)).toContain("delivery-ready");
  });

  it("mixes category and filter freely", () => {
    const cards = catalogCards(base);
    const result = filterCards(cards, { category: "marketing", shortOnly: true, q: "ad" });
    expect(result.every((c) => c.category === "marketing" && c.isShort)).toBe(true);
    expect(result.map((c) => c.id)).toContain("ad-recall");
  });
});

describe("template detail", () => {
  it("returns the full detail in the admin language", () => {
    const detail = catalogDetail({ ...base, id: "channel-compass" })!;
    expect(detail.name).toBe("Channel Compass");
    expect(detail.learn.length).toBeGreaterThanOrEqual(2);
    expect(detail.questions.length).toBe(3);
    expect(detail.packFamily).toBe("channels");
    expect(detail.ideas.length).toBeGreaterThan(0);
  });

  it("marks the show-if parent and options on a follow-up question", () => {
    const detail = catalogDetail({ ...base, id: "channel-compass" })!;
    const creator = detail.questions.find((q) => q.key === "q_creator")!;
    expect(creator.showIfParentKey).toBe("q_channel");
    expect(creator.showIfOptionKeys).toContain("tiktok");
  });

  it("resolves the region pack options from the shop's country", () => {
    const us = catalogDetail({ ...base, id: "channel-compass", country: "US" })!;
    const eu = catalogDetail({ ...base, id: "channel-compass", country: "DE" })!;
    const usKeys = us.questions[0]!.packOptions.map((o) => o.key);
    const euKeys = eu.questions[0]!.packOptions.map((o) => o.key);
    expect(usKeys).toContain("podcast");
    expect(euKeys).toContain("newspaper_magazine");
    expect(euKeys).not.toContain("online_marketplace");
  });

  it("returns null for an unknown template id", () => {
    expect(catalogDetail({ ...base, id: "nope" })).toBeNull();
  });
});

describe("template placements", () => {
  it("maps survey_link to the config's link placement", () => {
    expect(templatePlacements(templateById("after-delivery")!)).toEqual(["link"]);
    expect(templatePlacements(templateById("loyalty-pulse")!)).toEqual(["thank_you", "order_status"]);
  });
});

describe("seasonal spotlight (T15)", () => {
  it("shows a spotlight for a US shop in late November", () => {
    const spot = currentSpotlight({
      locale: "en",
      region: "us",
      now: new Date("2026-11-20T12:00:00Z"),
    });
    // year_end_holidays and bfcm overlap on Nov 20; the earlier table row wins.
    expect(spot?.seasonId).toBe("year_end_holidays");
    expect(spot?.templateId).toBe("gift-radar");
    expect(spot?.banner.length).toBeGreaterThan(0);
  });

  it("shows no spotlight in a quiet month", () => {
    expect(currentSpotlight({ locale: "en", region: "us", now: new Date("2026-07-01T12:00:00Z") })).toBeNull();
  });

  it("shows the earlier season first when two overlap", () => {
    // year_end_holidays (Nov 1–Dec 20) comes before bfcm (Nov 15–Dec 2) in the
    // table, so on Nov 20 the holidays window is the first match.
    const spot = currentSpotlight({ locale: "en", region: "us", now: new Date("2026-11-20T12:00:00Z") });
    expect(spot?.seasonId).toBe("year_end_holidays");
  });
});

describe("region packs", () => {
  it("maps countries to region packs", () => {
    expect(regionPackFor("US")).toBe("us");
    expect(regionPackFor(null)).toBe("us");
    expect(regionPackFor("DE")).toBe("eu");
    expect(regionPackFor("GB")).toBe("eu");
    expect(regionPackFor("IN")).toBe("global");
  });
});

describe("locale coverage", () => {
  it("has a bundle for every APP_LOCALE", () => {
    expect(Object.keys(TEMPLATE_BUNDLES).sort()).toEqual(
      ["de", "en", "es", "fr", "it", "ja", "nl", "pt-BR", "sv", "zh-CN"].sort(),
    );
  });

  it("keeps an English tag text at or under 32 characters", () => {
    for (const [id, text] of Object.entries(TAG_EN)) {
      expect(isTagId(id)).toBe(true);
      expect(text.length, `${id} = "${text}"`).toBeLessThanOrEqual(32);
    }
  });

  it("uses only valid tags on every template, at most 3", () => {
    for (const template of TEMPLATES) {
      expect(template.outcomeTags.length).toBeGreaterThanOrEqual(1);
      expect(template.outcomeTags.length).toBeLessThanOrEqual(3);
      for (const tag of template.outcomeTags) expect(isTagId(tag)).toBe(true);
    }
  });

  it("lists every category in the tab order", () => {
    expect(CATEGORY_ORDER).toEqual([
      "marketing",
      "product_page",
      "delivery",
      "loyalty",
      "know_customer",
      "after_delivery",
    ]);
  });
});

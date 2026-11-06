/**
 * The App Store listing must state pricing and the trial exactly as the app
 * bills them (App Store requirements; Built for Shopify listing rules). The
 * copy lives in docs/07 §4, the prices in `app/lib/plans.ts`: this keeps the
 * two from drifting.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { formatMoney } from "~/lib/money";
import { FREE_RESPONSE_CAP, PLANS, TRIAL_DAYS } from "~/lib/plans";

const doc = readFileSync("docs/07-deploy-and-submission.md", "utf8");
const listing = doc.slice(doc.indexOf("## 4. App Store listing copy"), doc.indexOf("## 5."));

describe("App Store listing copy", () => {
  it("states every price as billed", () => {
    for (const key of ["growth", "scale"] as const) {
      const plan = PLANS[key];
      expect(listing).toContain(`${formatMoney(plan.priceMinor, "USD", "en-US")} a month`);
      expect(listing).toContain(`${formatMoney(plan.yearlyPriceMinor, "USD", "en-US")} a year`);
    }
    expect(listing).toContain(`up to ${FREE_RESPONSE_CAP} answers a month`);
  });

  it("states the trial as billed", () => {
    expect(listing).toContain(`${TRIAL_DAYS}-day free trial, once per store`);
  });

  it("makes no statistical or competitor claims", () => {
    expect(listing).not.toMatch(/\d+\s?%|\bx\d|\bbest\b|#1|number one|\bvs\.?\b|better than|faster than/i);
  });
});

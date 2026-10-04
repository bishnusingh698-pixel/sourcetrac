import { describe, expect, it } from "vitest";

import { PLANS, planPriceAmount } from "~/lib/plans";

/**
 * Shopify's money `amount` is a major-unit decimal. `priceMinor` is minor units,
 * and sending it unconverted charged 100x the advertised price.
 */
describe("planPriceAmount", () => {
  it("renders Growth as 19.00, not 1900", () => {
    expect(PLANS.growth.priceMinor).toBe(1900);
    expect(planPriceAmount("growth")).toBe("19.00");
  });

  it("renders Scale as 49.00, not 4900", () => {
    expect(planPriceAmount("scale")).toBe("49.00");
  });

  it("renders Free as 0.00", () => {
    expect(planPriceAmount("free")).toBe("0.00");
  });
});

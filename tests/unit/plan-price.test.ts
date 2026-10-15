import { describe, expect, it } from "vitest";

import { cycleOf, isOnLegacyPrice, type ActiveSubscription } from "~/lib/billing.server";
import {
  BILLING_INTERVALS,
  cycleFromInterval,
  PLANS,
  planPriceAmount,
  subscriptionName,
  YEARLY_DISCOUNT_PERCENT,
} from "~/lib/plans";
import { matchPlanByDisplayName } from "~/lib/webhooks.server";

/**
 * Shopify's money `amount` is a major-unit decimal. `priceMinor` is minor units,
 * and sending it unconverted charged 100x the advertised price.
 */
describe("planPriceAmount", () => {
  it("renders Growth as 4.99, not 499", () => {
    expect(PLANS.growth.priceMinor).toBe(499);
    expect(planPriceAmount("growth")).toBe("4.99");
  });

  it("renders Scale as 9.99, not 999", () => {
    expect(PLANS.scale.priceMinor).toBe(999);
    expect(planPriceAmount("scale")).toBe("9.99");
  });

  it("renders Free as 0.00", () => {
    expect(planPriceAmount("free")).toBe("0.00");
    expect(planPriceAmount("free", "yearly")).toBe("0.00");
  });
});

describe("yearly pricing", () => {
  it("is twelve months less the discount, to the cent", () => {
    expect(YEARLY_DISCOUNT_PERCENT).toBe(10);
    // 4.99 x 12 = 59.88, less 10% = 53.892 -> 53.89
    expect(planPriceAmount("growth", "yearly")).toBe("53.89");
    // 9.99 x 12 = 119.88, less 10% = 107.892 -> 107.89
    expect(planPriceAmount("scale", "yearly")).toBe("107.89");
  });

  it("bills yearly on Shopify's ANNUAL interval and monthly on EVERY_30_DAYS", () => {
    expect(BILLING_INTERVALS.yearly).toBe("ANNUAL");
    expect(BILLING_INTERVALS.monthly).toBe("EVERY_30_DAYS");
    expect(cycleFromInterval("ANNUAL")).toBe("yearly");
    expect(cycleFromInterval("EVERY_30_DAYS")).toBe("monthly");
    expect(cycleFromInterval(undefined)).toBeNull();
  });

  it("names the yearly charge so both matchers still recognise the plan", () => {
    // The monthly name is unchanged, so existing subscriptions keep matching.
    expect(subscriptionName("growth")).toBe("SourceTrac — Growth");
    expect(subscriptionName("scale", "yearly")).toBe("SourceTrac — Scale (yearly)");
    expect(matchPlanByDisplayName(subscriptionName("growth", "yearly"))).toEqual({ key: "growth" });
    expect(matchPlanByDisplayName(subscriptionName("scale", "yearly"))).toEqual({ key: "scale" });
  });
});

describe("subscriptions approved at the old price", () => {
  const sub = (overrides: Partial<ActiveSubscription>): ActiveSubscription => ({
    id: "gid://shopify/AppSubscription/1",
    name: "SourceTrac — Growth",
    status: "ACTIVE",
    test: false,
    currentPeriodEnd: null,
    ...overrides,
  });

  it("flags a Growth charge still billed at $19", () => {
    expect(isOnLegacyPrice(sub({ cycle: "monthly", priceAmount: "19.0", currencyCode: "USD" }), "growth")).toBe(true);
  });

  it("does not flag a charge at today's price, monthly or yearly", () => {
    expect(isOnLegacyPrice(sub({ cycle: "monthly", priceAmount: "4.99", currencyCode: "USD" }), "growth")).toBe(false);
    expect(isOnLegacyPrice(sub({ cycle: "yearly", priceAmount: "53.89", currencyCode: "USD" }), "growth")).toBe(false);
  });

  it("never flags on a guess: no price, another currency, or no subscription", () => {
    expect(isOnLegacyPrice(sub({}), "growth")).toBe(false);
    expect(isOnLegacyPrice(sub({ priceAmount: "19.0", currencyCode: "EUR" }), "growth")).toBe(false);
    expect(isOnLegacyPrice(null, "growth")).toBe(false);
  });

  it("reads a subscription without a line item as monthly", () => {
    expect(cycleOf(sub({}))).toBe("monthly");
    expect(cycleOf(sub({ cycle: "yearly" }))).toBe("yearly");
  });
});

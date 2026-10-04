import { describe, expect, it } from "vitest";

import { effectivePlan } from "~/lib/plans";
import { evaluateRevenue, type OrderFacts } from "~/lib/revenue";

/**
 * Net revenue is Shopify's `current_total_price` taken as-is. That field already
 * reflects refunds, returns and edits, so nothing here may subtract a refund from
 * it. Each case below is a shape a merchant's orders really take.
 */
const order = (overrides: Partial<OrderFacts> = {}): OrderFacts => ({
  currency: "USD",
  totalPrice: "100.00",
  financialStatus: "paid",
  isTest: false,
  isCancelled: false,
  ...overrides,
});

describe("net revenue is current_total_price as-is", () => {
  it("no refund: the full total", () => {
    expect(evaluateRevenue(order())).toEqual({ included: true, minor: 10000 });
  });

  it("one partial refund: counted once (100.00 less 25.00 is 75.00, not 50.00)", () => {
    expect(
      evaluateRevenue(order({ financialStatus: "partially_refunded", totalPrice: "75.00" })),
    ).toEqual({ included: true, minor: 7500 });
  });

  it("multiple partial refunds: whatever Shopify reports as current", () => {
    expect(
      evaluateRevenue(order({ financialStatus: "partially_refunded", totalPrice: "55.00" })),
    ).toEqual({ included: true, minor: 5500 });
  });

  it("ignores any refund-looking property on the facts", () => {
    // Even if a refund amount were somehow present, it must not be subtracted.
    const facts = {
      ...order({ financialStatus: "partially_refunded", totalPrice: "75.00" }),
      totalRefunded: "25.00",
    } as unknown as OrderFacts;

    expect(evaluateRevenue(facts)).toEqual({ included: true, minor: 7500 });
  });

  it("full refund: excluded, never negative", () => {
    expect(
      evaluateRevenue(order({ financialStatus: "refunded", totalPrice: "0.00" })),
    ).toEqual({ included: false, reason: "fully_refunded" });
  });

  it("partially_refunded with nothing left: excluded as fully refunded", () => {
    expect(
      evaluateRevenue(order({ financialStatus: "partially_refunded", totalPrice: "0.00" })),
    ).toEqual({ included: false, reason: "fully_refunded" });
  });

  it("cancelled: excluded", () => {
    expect(evaluateRevenue(order({ isCancelled: true }))).toEqual({
      included: false,
      reason: "cancelled",
    });
  });

  it("test order: excluded", () => {
    expect(evaluateRevenue(order({ isTest: true }))).toEqual({
      included: false,
      reason: "test_order",
    });
  });

  it("order edit: follows the edited total", () => {
    expect(evaluateRevenue(order({ totalPrice: "120.00" }))).toEqual({ included: true, minor: 12000 });
    expect(evaluateRevenue(order({ totalPrice: "80.00" }))).toEqual({ included: true, minor: 8000 });
  });

  it("a genuine free order still counts, at zero", () => {
    expect(evaluateRevenue(order({ totalPrice: "0.00" }))).toEqual({ included: true, minor: 0 });
  });

  it("currency and rounding: exact minor units for 0, 2 and 3 decimal currencies", () => {
    expect(evaluateRevenue(order({ currency: "JPY", totalPrice: "5000" }))).toEqual({
      included: true,
      minor: 5000,
    });
    expect(evaluateRevenue(order({ currency: "KWD", totalPrice: "1.234" }))).toEqual({
      included: true,
      minor: 1234,
    });
    // Postgres hands back a Decimal(12,3) at scale 3, even for USD.
    expect(evaluateRevenue(order({ totalPrice: "42.500" }))).toEqual({ included: true, minor: 4250 });
    expect(evaluateRevenue(order({ totalPrice: "19.99" }))).toEqual({ included: true, minor: 1999 });
  });

  it("an unparseable or missing total is excluded, never read as zero", () => {
    expect(evaluateRevenue(order({ totalPrice: null }))).toEqual({
      included: false,
      reason: "unparseable_total",
    });
    expect(evaluateRevenue(order({ totalPrice: "not-a-number" }))).toEqual({
      included: false,
      reason: "unparseable_total",
    });
  });
});

describe("effectivePlan", () => {
  it("honours a paid plan only while its subscription is active", () => {
    expect(effectivePlan({ plan: "growth", planStatus: "active" })).toBe("growth");
    expect(effectivePlan({ plan: "scale", planStatus: "active" })).toBe("scale");
  });

  it("falls back to free for every other status, matching what the API enforces", () => {
    for (const planStatus of ["cancelled", "declined", "expired", "frozen", "mystery"]) {
      expect(effectivePlan({ plan: "growth", planStatus })).toBe("free");
    }
  });

  it("falls back to free for an unknown plan key", () => {
    expect(effectivePlan({ plan: "enterprise", planStatus: "active" })).toBe("free");
  });
});

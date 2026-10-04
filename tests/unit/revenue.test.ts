import { describe, expect, it } from "vitest";

import { evaluateResponseRevenue, evaluateRevenue, rollupByCurrency, type OrderFacts } from "~/lib/revenue";
import {
  averageOrderValue,
  formatMoney,
  minorUnitDigits,
  minorToDecimalString,
  parseMoneyToMinor,
  percentChange,
  sumByCurrency,
} from "~/lib/money";

/**
 * Revenue is the product. A wrong number here is a wrong number a merchant makes
 * a marketing budget decision on, so these tests are deliberately exhaustive
 * about the edge cases rather than just the happy path.
 */

const order = (overrides: Partial<OrderFacts> = {}): OrderFacts => ({
  currency: "USD",
  totalPrice: "100.00",
  financialStatus: "paid",
  isTest: false,
  isCancelled: false,
  ...overrides,
});

describe("evaluateRevenue", () => {
  it("includes a paid order at its total", () => {
    expect(evaluateRevenue(order())).toEqual({ included: true, minor: 10000 });
  });

  it("excludes test orders", () => {
    expect(evaluateRevenue(order({ isTest: true }))).toEqual({ included: false, reason: "test_order" });
  });

  it("excludes cancelled orders", () => {
    expect(evaluateRevenue(order({ isCancelled: true }))).toEqual({ included: false, reason: "cancelled" });
  });

  it("excludes voided orders", () => {
    expect(evaluateRevenue(order({ financialStatus: "voided" }))).toEqual({
      included: false,
      reason: "voided",
    });
  });

  it("excludes a fully refunded order rather than reporting negative revenue", () => {
    const result = evaluateRevenue(order({ financialStatus: "refunded", totalPrice: "0.00" }));
    expect(result).toEqual({ included: false, reason: "fully_refunded" });
  });

  it("takes the total as already net, so a partial refund is deducted once", () => {
    // Shopify lowers current_total_price when it refunds, so 75.00 here IS the
    // net amount of a 100.00 order with 25.00 refunded. Subtracting the refund
    // again would report 50.00.
    const result = evaluateRevenue(
      order({ financialStatus: "partially_refunded", totalPrice: "75.00" }),
    );
    expect(result).toEqual({ included: true, minor: 7500 });
  });

  it("excludes a partially refunded order with nothing left", () => {
    const result = evaluateRevenue(
      order({ financialStatus: "partially_refunded", totalPrice: "0.00" }),
    );
    expect(result).toEqual({ included: false, reason: "fully_refunded" });
  });

  it("includes a pending order, since the money is real but not settled", () => {
    expect(evaluateRevenue(order({ financialStatus: "pending" })).included).toBe(true);
  });

  it("includes an order with a null financialStatus", () => {
    expect(evaluateRevenue(order({ financialStatus: null })).included).toBe(true);
  });

  it("excludes an unparseable total instead of guessing zero", () => {
    const result = evaluateRevenue(order({ totalPrice: "not-a-number" }));
    expect(result).toEqual({ included: false, reason: "unparseable_total" });
  });

  it("applies test-order exclusion before anything else", () => {
    // A cancelled test order is still a test order; the reason matters for logs.
    expect(evaluateRevenue(order({ isTest: true, isCancelled: true })).included).toBe(false);
  });

  it("handles a zero-decimal currency without dividing wrongly", () => {
    const result = evaluateRevenue(order({ currency: "JPY", totalPrice: "5000" }));
    expect(result).toEqual({ included: true, minor: 5000 });
  });
});

describe("evaluateResponseRevenue", () => {
  it("reports an unreconciled response as pending, never as zero", () => {
    const result = evaluateResponseRevenue({ reconciled: false, unreconcilable: false }, null);
    expect(result).toEqual({ included: false, reason: "unreconciled" });
  });

  it("still excludes an unreconciled response even if order data exists", () => {
    const result = evaluateResponseRevenue({ reconciled: true, unreconcilable: true }, order());
    expect(result).toEqual({ included: false, reason: "unreconciled" });
  });

  it("delegates to evaluateRevenue once reconciled", () => {
    const result = evaluateResponseRevenue({ reconciled: true, unreconcilable: false }, order());
    expect(result).toEqual({ included: true, minor: 10000 });
  });
});

describe("rollupByCurrency", () => {
  it("never sums across currencies", () => {
    const result = rollupByCurrency([
      { currency: "USD", minor: 10000 },
      { currency: "EUR", minor: 9000 },
    ]);
    expect(result).toEqual(expect.arrayContaining([{ currency: "USD", minor: 10000 }]));
    expect(result).toEqual(expect.arrayContaining([{ currency: "EUR", minor: 9000 }]));
    expect(result).toHaveLength(2);
  });

  it("sums within a single currency", () => {
    const result = rollupByCurrency([
      { currency: "USD", minor: 10000 },
      { currency: "USD", minor: 2500 },
    ]);
    expect(result).toEqual([{ currency: "USD", minor: 12500 }]);
  });
});

describe("parseMoneyToMinor", () => {
  it("parses a two-decimal currency", () => {
    expect(parseMoneyToMinor("19.99", "USD")).toEqual({ ok: true, minor: 1999, decimals: 2 });
  });

  it("parses a zero-decimal currency without adding cents", () => {
    expect(parseMoneyToMinor("5000", "JPY")).toEqual({ ok: true, minor: 5000, decimals: 0 });
  });

  it("parses a three-decimal currency", () => {
    expect(parseMoneyToMinor("1.234", "KWD")).toEqual({ ok: true, minor: 1234, decimals: 3 });
  });

  it("reports the sign on a negative amount, and evaluateRevenue excludes it", () => {
    // parseMoneyToMinor stays honest about what it received; the decision about
    // whether a negative total may become revenue belongs to evaluateRevenue.
    const parsed = parseMoneyToMinor("-5.00", "USD");
    expect(parsed).toEqual({ ok: true, minor: -500, decimals: 2 });
    expect(evaluateRevenue(order({ totalPrice: "-5.00" }))).toEqual({
      included: false,
      reason: "unparseable_total",
    });
  });

  it("rejects garbage", () => {
    expect(parseMoneyToMinor("abc", "USD").ok).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(parseMoneyToMinor(null, "USD").ok).toBe(false);
    expect(parseMoneyToMinor(undefined, "USD").ok).toBe(false);
  });

  /**
   * Postgres renders a numeric at its declared column scale, so a USD total stored
   * in a `Decimal(12,3)` column reads back as "42.500". Insignificant trailing
   * zeros must not be read as precision, or every two-decimal order's revenue is
   * excluded from the dashboard as `unparseable_total`.
   */
  it("ignores insignificant trailing zeros past the currency's precision", () => {
    expect(parseMoneyToMinor("42.500", "USD")).toEqual({ ok: true, minor: 4250, decimals: 2 });
    expect(parseMoneyToMinor("42.000", "USD")).toEqual({ ok: true, minor: 4200, decimals: 2 });
    expect(parseMoneyToMinor("7.000", "JPY")).toEqual({ ok: true, minor: 7, decimals: 0 });
    expect(parseMoneyToMinor("19.990", "KWD")).toEqual({ ok: true, minor: 19990, decimals: 3 });
  });

  it("still rejects precision the currency genuinely cannot represent", () => {
    expect(parseMoneyToMinor("42.501", "USD").ok).toBe(false);
    expect(parseMoneyToMinor("42.5001", "KWD").ok).toBe(false);
    expect(parseMoneyToMinor("5000.5", "JPY").ok).toBe(false);
  });

  /**
   * The previous pattern `^-?\d*(\.\d+)?$` accepted "", "   " and "-", all of
   * which fell through to a clean zero and read as a real $0.00 order rather than
   * as a payload we could not interpret.
   */
  it("rejects a blank or digit-less amount instead of reading it as zero", () => {
    expect(parseMoneyToMinor("   ", "USD").ok).toBe(false);
    expect(parseMoneyToMinor("-", "USD").ok).toBe(false);
    expect(parseMoneyToMinor(".", "USD").ok).toBe(false);
  });

  it("still parses a leading-decimal amount", () => {
    // Shopify does not send this, but rejecting it would be a behaviour change
    // beyond the bug being fixed.
    expect(parseMoneyToMinor("0.5", "USD")).toEqual({ ok: true, minor: 50, decimals: 2 });
  });
});

describe("minorUnitDigits", () => {
  it("knows common zero- and three-decimal currencies", () => {
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(minorUnitDigits("USD")).toBe(2);
    expect(minorUnitDigits("KWD")).toBe(3);
  });

  it("falls back to two digits for an unknown currency", () => {
    expect(minorUnitDigits("ZZZ")).toBe(2);
  });
});

describe("minorToDecimalString", () => {
  it("round-trips through parseMoneyToMinor", () => {
    const parsed = parseMoneyToMinor("19.99", "USD");
    if (!parsed.ok) throw new Error("expected parse to succeed");
    expect(minorToDecimalString(parsed.minor, "USD")).toBe("19.99");
  });

  it("does not add decimals to JPY", () => {
    expect(minorToDecimalString(5000, "JPY")).toBe("5000");
  });
});

describe("averageOrderValue", () => {
  it("returns null on zero orders instead of NaN or Infinity", () => {
    expect(averageOrderValue(10000, 0)).toBeNull();
  });

  it("divides correctly", () => {
    expect(averageOrderValue(10000, 4)).toBe(2500);
  });
});

describe("percentChange", () => {
  it("returns null when the previous value is zero", () => {
    expect(percentChange(10, 0)).toBeNull();
  });

  it("returns a percentage, not a ratio", () => {
    expect(percentChange(110, 100)).toBeCloseTo(10);
  });

  it("reports a decline as negative", () => {
    expect(percentChange(90, 100)).toBeCloseTo(-10);
  });
});

describe("sumByCurrency", () => {
  it("keeps currencies separate and never adds them together", () => {
    const result = sumByCurrency([
      { amount: "10.00", currency: "USD" },
      { amount: "10.00", currency: "GBP" },
    ]);
    expect(result).toHaveLength(2);
    expect(result).toEqual([
      { currency: "GBP", minor: 1000 },
      { currency: "USD", minor: 1000 },
    ]);
  });

  it("sums within one currency", () => {
    expect(sumByCurrency([{ amount: "10.00", currency: "USD" }, { amount: "5.50", currency: "USD" }])).toEqual([
      { currency: "USD", minor: 1550 },
    ]);
  });

  it("excludes an unparseable amount instead of counting it as zero", () => {
    expect(sumByCurrency([{ amount: "oops", currency: "USD" }, { amount: "10.00", currency: "USD" }])).toEqual([
      { currency: "USD", minor: 1000 },
    ]);
  });
});

describe("formatMoney", () => {
  it("formats using the currency's own minor units", () => {
    expect(formatMoney(5000, "JPY")).toContain("5,000");
  });

  it("renders null without throwing", () => {
    expect(formatMoney(null, "USD")).toBeTruthy();
  });
});

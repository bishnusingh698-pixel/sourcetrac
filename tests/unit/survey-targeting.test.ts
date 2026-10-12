import { describe, expect, it } from "vitest";

import { matchesTargeting, type Targeting } from "@shared/survey-config";

const base = {
  orderId: "123",
  orderTotalMinor: 5000,
  currency: "USD",
  currencyDigits: 2,
  isFirstOrder: null as boolean | null,
  country: null as string | null,
  language: null as string | null,
  now: new Date("2026-06-15T12:00:00Z"),
  responseCount: 0,
};

function target(overrides: Partial<Targeting>): Targeting {
  return overrides as Targeting;
}

describe("matchesTargeting", () => {
  it("matches when nothing is set", () => {
    expect(matchesTargeting(undefined, base)).toBe(true);
    expect(matchesTargeting({}, base)).toBe(true);
  });

  it("excludes before startsAt and at/after endsAt", () => {
    expect(matchesTargeting(target({ startsAt: "2026-07-01T00:00:00Z" }), base)).toBe(false);
    expect(matchesTargeting(target({ endsAt: "2026-06-15T12:00:00Z" }), base)).toBe(false);
    expect(matchesTargeting(target({ startsAt: "2026-06-01T00:00:00Z" }), base)).toBe(true);
  });

  it("excludes once maxResponses is reached", () => {
    expect(matchesTargeting(target({ maxResponses: 0 }), base)).toBe(false);
    expect(matchesTargeting(target({ maxResponses: 1 }), { ...base, responseCount: 1 })).toBe(false);
    expect(matchesTargeting(target({ maxResponses: 5 }), { ...base, responseCount: 1 })).toBe(true);
  });

  it("samples deterministically per order id", () => {
    const at20 = target({ samplePercent: 20 });
    // Same order always yields the same decision.
    const first = matchesTargeting(at20, { ...base, orderId: "555" });
    const second = matchesTargeting(at20, { ...base, orderId: "555" });
    expect(first).toBe(second);
    // 100% always matches; 0% never does.
    expect(matchesTargeting(target({ samplePercent: 100 }), base)).toBe(true);
    expect(matchesTargeting(target({ samplePercent: 0 }), base)).toBe(false);
    // An on-site response with no order id cannot be sampled.
    expect(matchesTargeting(at20, { ...base, orderId: null })).toBe(false);
  });

  it("filters on first-order vs returning", () => {
    expect(matchesTargeting(target({ customerType: "first_order" }), { ...base, isFirstOrder: true })).toBe(true);
    expect(matchesTargeting(target({ customerType: "first_order" }), { ...base, isFirstOrder: false })).toBe(false);
    expect(matchesTargeting(target({ customerType: "returning" }), { ...base, isFirstOrder: false })).toBe(true);
    expect(matchesTargeting(target({ customerType: "everyone" }), base)).toBe(true);
  });

  it("skips the value rule when the currency differs", () => {
    const targeting = target({ minValue: 100, valueCurrency: "EUR" });
    // Order is USD, rule is EUR: not skipped-by-mismatch would wrongly hide it.
    expect(matchesTargeting(targeting, { ...base, currency: "USD" })).toBe(true);
    expect(matchesTargeting(targeting, { ...base, currency: "EUR", orderTotalMinor: 5000 })).toBe(false);
    expect(matchesTargeting(targeting, { ...base, currency: "EUR", orderTotalMinor: 20000 })).toBe(true);
  });

  it("uses the currency's own precision for value bounds", () => {
    // JPY has 0 decimal digits: a 1000-yen bound is 1000 minor units, not 100000.
    const jpy = target({ minValue: 1000, valueCurrency: "JPY" });
    expect(matchesTargeting(jpy, { ...base, currency: "JPY", currencyDigits: 0, orderTotalMinor: 999 })).toBe(false);
    expect(matchesTargeting(jpy, { ...base, currency: "JPY", currencyDigits: 0, orderTotalMinor: 1000 })).toBe(true);
  });

  it("filters on country and language", () => {
    expect(matchesTargeting(target({ countries: ["US"] }), { ...base, country: "US" })).toBe(true);
    expect(matchesTargeting(target({ countries: ["US"] }), { ...base, country: "DE" })).toBe(false);
    expect(matchesTargeting(target({ countries: ["US"] }), base)).toBe(false);
    expect(matchesTargeting(target({ languages: ["de"] }), { ...base, language: "de" })).toBe(true);
  });
});

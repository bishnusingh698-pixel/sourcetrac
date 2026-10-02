import { describe, expect, it } from "vitest";

import { formatMoney, shopifyDecimalAmount } from "~/lib/money";
import { PLANS } from "~/lib/plans";

/**
 * The charge amount sent to Shopify.
 *
 * `PlanDefinition.priceMinor` is minor units — $19.00 is 1900. But GraphQL's
 * `Decimal` scalar is serialised as a *string* carrying major units: `"29.99"`
 * means twenty-nine dollars and ninety-nine cents, not 2999 cents. Passing the
 * raw minor integer therefore charges 100x the advertised price.
 *
 * `shopifyDecimalAmount` is the one conversion both the billing path and the
 * plans page must agree on.
 */
describe("shopifyDecimalAmount", () => {
  it("converts minor units to the major-unit string Shopify expects", () => {
    expect(shopifyDecimalAmount(1900, "USD")).toBe("19.00");
    expect(shopifyDecimalAmount(4900, "USD")).toBe("49.00");
    expect(shopifyDecimalAmount(0, "USD")).toBe("0.00");
  });

  it("keeps the minor unit's precision", () => {
    expect(shopifyDecimalAmount(1999, "USD")).toBe("19.99");
    expect(shopifyDecimalAmount(100, "USD")).toBe("1.00");
    expect(shopifyDecimalAmount(5, "USD")).toBe("0.05");
  });

  it("charges exactly the prices the docs and the plans page advertise", () => {
    // docs/03-logic-spec.md FLOW 13 and docs/07 both say $19 and $49. Charging
    // the raw minor integer billed Growth at $1,900.00/month instead.
    expect(shopifyDecimalAmount(PLANS.growth.priceMinor, PLANS.growth.currencyCode)).toBe("19.00");
    expect(shopifyDecimalAmount(PLANS.scale.priceMinor, PLANS.scale.currencyCode)).toBe("49.00");
  });

  it("agrees with the plans-page rendering, so the card and the charge match", () => {
    // The plans page shows formatMoney(priceMinor, currencyCode). The merchant
    // approves that number on Shopify's confirmation screen, so the amount sent
    // in the mutation must parse to the same figure.
    const shown = formatMoney(PLANS.growth.priceMinor, PLANS.growth.currencyCode, "en-US");
    expect(shown).toBe("$19.00");
    expect(Number(shopifyDecimalAmount(PLANS.growth.priceMinor, PLANS.growth.currencyCode))).toBe(19);
  });
});
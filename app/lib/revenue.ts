/**
 * Revenue eligibility policy (docs/03 FLOW 14).
 *
 * Interpretation lives here, at read time, and nowhere else. The database
 * stores raw order facts; this module decides what counts as revenue so there
 * is exactly one place to audit when the policy changes.
 */

import { parseMoneyToMinor, type CurrencyCode } from "./money";

export type OrderFacts = {
  currency: string;
  totalPrice: string | number;
  totalRefunded: string | number;
  financialStatus: string | null;
  isTest: boolean;
  isCancelled: boolean;
};

export type RevenueExclusionReason =
  | "test_order"
  | "cancelled"
  | "voided"
  | "fully_refunded"
  | "unreconciled"
  | "unparseable_total";

export type RevenueDecision =
  | { included: true; minor: number; treatment: "gross" | "net_of_refunds" }
  | { included: false; reason: RevenueExclusionReason };

/**
 * Decide whether a cached order contributes revenue, and at what amount.
 *
 * Policy:
 *   test order             -> excluded
 *   cancelled              -> excluded
 *   financialStatus voided -> excluded
 *   refunded               -> excluded (fully refunded == no revenue)
 *   partially_refunded     -> included, net of refunds
 *   paid / pending / null  -> included, gross
 */
export function evaluateRevenue(order: OrderFacts): RevenueDecision {
  if (order.isTest) return { included: false, reason: "test_order" };
  if (order.isCancelled) return { included: false, reason: "cancelled" };

  const status = order.financialStatus?.toLowerCase() ?? null;

  if (status === "voided") return { included: false, reason: "voided" };
  if (status === "refunded") return { included: false, reason: "fully_refunded" };

  const total = parseMoneyToMinor(order.totalPrice, order.currency);
  if (!total.ok) return { included: false, reason: "unparseable_total" };

  // A negative order total is not something Shopify sends, so it means a
  // malformed payload. Exclude it rather than let it subtract from a channel's
  // revenue and report a total the merchant cannot explain.
  if (total.minor < 0) return { included: false, reason: "unparseable_total" };

  if (status === "partially_refunded") {
    const refunded = parseMoneyToMinor(order.totalRefunded ?? 0, order.currency);
    // An unparseable refund amount falls back to gross rather than
    // understating revenue: the refund is unknown, not confidently zero.
    if (!refunded.ok) return { included: true, minor: total.minor, treatment: "gross" };
    const net = total.minor - refunded.minor;
    if (net <= 0) return { included: false, reason: "fully_refunded" };
    return { included: true, minor: net, treatment: "net_of_refunds" };
  }

  return { included: true, minor: total.minor, treatment: "gross" };
}

export type ResponseFacts = {
  reconciled: boolean;
  unreconcilable: boolean;
};

/**
 * A response with no order data yet is "Pending", never $0.00. Showing zero
 * would be a factual error: we do not know the order total, it is not zero.
 */
export function evaluateResponseRevenue(
  response: ResponseFacts,
  order: OrderFacts | null,
): RevenueDecision {
  if (!response.reconciled || response.unreconcilable || !order) {
    return { included: false, reason: "unreconciled" };
  }
  return evaluateRevenue(order);
}

/**
 * Group already-decided amounts by currency. Kept here so no caller can
 * accidentally flatten a multi-currency result into one number.
 */
export function rollupByCurrency(
  entries: ReadonlyArray<{ currency: CurrencyCode; minor: number }>,
): Array<{ currency: CurrencyCode; minor: number }> {
  const totals = new Map<CurrencyCode, number>();
  for (const { currency, minor } of entries) {
    const next = (totals.get(currency) ?? 0) + minor;
    if (Number.isSafeInteger(next)) totals.set(currency, next);
  }
  return [...totals.entries()]
    .map(([currency, minor]) => ({ currency, minor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

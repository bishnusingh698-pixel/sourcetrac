/**
 * Plan definitions and the Free-plan response cap.
 *
 * Prices are USD. The cap is the only enforced limit; paid plans are
 * unlimited. `null` cap means unlimited and is checked explicitly so a
 * comparison against null can never accidentally evaluate true.
 */

export const PLAN_FREE = "free" as const;
export const PLAN_GROWTH = "growth" as const;
export const PLAN_SCALE = "scale" as const;

export type PlanKey = typeof PLAN_FREE | typeof PLAN_GROWTH | typeof PLAN_SCALE;

export const FREE_RESPONSE_CAP = 50;
export const CAP_WARNING_RATIO = 0.8;

export type PlanDefinition = {
  key: PlanKey;
  name: string;
  /** Monthly price in the smallest currency unit, to avoid float money. */
  priceMinor: number;
  currencyCode: "USD";
  /** null = unlimited. */
  responseCap: number | null;
  features: string[];
  /** Name shown to the merchant on the Shopify charge confirmation page. */
  displayName: string;
};

export const PLANS: Record<PlanKey, PlanDefinition> = {
  free: {
    key: "free",
    name: "Free",
    priceMinor: 0,
    currencyCode: "USD",
    responseCap: FREE_RESPONSE_CAP,
    displayName: "SourceTrac — Free",
    features: [
      `${FREE_RESPONSE_CAP} survey responses per month`,
      "Revenue and average order value by channel",
      "7, 30 and 90 day trends",
      "CSV export",
    ],
  },
  growth: {
    key: "growth",
    name: "Growth",
    priceMinor: 1900,
    currencyCode: "USD",
    responseCap: null,
    displayName: "SourceTrac — Growth",
    features: [
      "Unlimited survey responses",
      "Everything in Free",
      "Priority support",
    ],
  },
  scale: {
    key: "scale",
    name: "Scale",
    priceMinor: 4900,
    currencyCode: "USD",
    responseCap: null,
    displayName: "SourceTrac — Scale",
    features: [
      "Unlimited survey responses",
      "Everything in Growth",
      "Priority support",
    ],
  },
};

export const PLAN_ORDER: PlanKey[] = [PLAN_FREE, PLAN_GROWTH, PLAN_SCALE];

export function isPlanKey(value: unknown): value is PlanKey {
  return value === PLAN_FREE || value === PLAN_GROWTH || value === PLAN_SCALE;
}

export function planFor(key: unknown): PlanDefinition {
  return isPlanKey(key) ? PLANS[key] : PLANS[PLAN_FREE];
}

/** Shopify's recurring interval enum value. */
export const BILLING_INTERVAL = "EVERY_30_DAYS" as const;

export type CapStatus = {
  cap: number | null;
  used: number;
  /** Threshold at which the upgrade banner appears. */
  warningAt: number | null;
  atWarning: boolean;
  atCap: boolean;
  exceeded: boolean;
  /** True when collection should continue but be flagged. */
  shouldFlag: boolean;
};

export function evaluateCap(planKey: unknown, used: number): CapStatus {
  const cap = planFor(planKey).responseCap;
  const safeUsed = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;

  if (cap === null) {
    return {
      cap: null,
      used: safeUsed,
      warningAt: null,
      atWarning: false,
      atCap: false,
      exceeded: false,
      shouldFlag: false,
    };
  }

  const warningAt = Math.ceil(cap * CAP_WARNING_RATIO);
  return {
    cap,
    used: safeUsed,
    warningAt,
    atWarning: safeUsed >= warningAt,
    atCap: safeUsed >= cap,
    exceeded: safeUsed > cap,
    shouldFlag: safeUsed >= cap,
  };
}

/** UTC month boundaries (docs/03 FLOW 15). */
export function currentUtcPeriod(now = new Date()): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { periodStart, periodEnd };
}

export function planStatusIsCollecting(status: string): boolean {
  // Only an explicitly cancelled/declined/expired/frozen subscription stops a
  // merchant being on a paid plan. Anything unknown keeps the paid behaviour so
  // a transient webhook gap never silently downgrades a paying merchant.
  return status === "active";
}

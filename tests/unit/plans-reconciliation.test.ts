import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isBillingNotEnabled, needsPlanSync, paidPlanFromSubscriptions } from "../../app/lib/billing.server";
import { planStatusIsCollecting } from "../../app/lib/plans";

/**
 * Guards the plans-page reconciliation.
 *
 * `paidPlanFromSubscriptions` returns `null` both for "genuinely on free" and
 * for "Shopify returned a charge we do not recognise". The loader collapsed
 * those two into `"free"` and then wrote `planStatus: "active"` alongside it,
 * which stamped a cancelled or expired subscription back to active and lost the
 * record of the cancellation entirely.
 *
 * The write itself is inside a loader, so the "do not claim active when
 * downgrading" rule is asserted against the source; the classification that
 * feeds it is exercised for real.
 */
const read = (relative: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../${relative}`, import.meta.url)),
    "utf8",
  );

const subscription = (over: Partial<Parameters<typeof paidPlanFromSubscriptions>[0][number]> = {}) => ({
  id: "gid://shopify/AppSubscription/1",
  name: "SourceTrac Growth",
  status: "ACTIVE",
  test: false,
  currentPeriodEnd: null,
  ...over,
});

describe("paidPlanFromSubscriptions", () => {
  it("never grants a paid plan from a test charge in production", () => {
    const testCharge = subscription({ test: true });
    expect(paidPlanFromSubscriptions([testCharge], { allowTest: false })).toBeNull();
    expect(paidPlanFromSubscriptions([testCharge], { allowTest: true })).toBe("growth");
  });

  it("reads a live growth or scale charge", () => {
    expect(paidPlanFromSubscriptions([subscription()])).toBe("growth");
    expect(paidPlanFromSubscriptions([subscription({ name: "SourceTrac Scale" })])).toBe("scale");
  });

  it("returns null for a charge that is not active", () => {
    expect(paidPlanFromSubscriptions([subscription({ status: "CANCELLED" })])).toBeNull();
    expect(paidPlanFromSubscriptions([subscription({ status: "EXPIRED" })])).toBeNull();
    expect(paidPlanFromSubscriptions([subscription({ status: "FROZEN" })])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(paidPlanFromSubscriptions([])).toBeNull();
  });

  it("ignores a charge that is not ours", () => {
    expect(paidPlanFromSubscriptions([subscription({ name: "Some Other App" })])).toBeNull();
  });
});

describe("plans loader reconciliation", () => {
  it("never writes planStatus active on the way down to free", () => {
    const source = read("app/routes/app.plans.tsx");

    // The old shape stamped the status unconditionally.
    expect(source).not.toMatch(/plan:\s*reconciled,\s*planStatus:\s*"active"/);

    // The free branch must not claim "active".
    expect(source).toMatch(/planStatus:\s*reconciled\s*===\s*"free"\s*\?\s*"expired"\s*:\s*"active"/);
  });

  it("still resolves to free after a downgrade, whatever status is recorded", () => {
    // Downgrading records "expired", so the collecting decision must not
    // depend on the status being left alone -- `plan` alone has to be enough.
    const effective = (plan: string, status: string) =>
      ["growth", "scale"].includes(plan) && planStatusIsCollecting(status) ? plan : "free";

    expect(effective("free", "expired")).toBe("free");
    expect(effective("free", "cancelled")).toBe("free");
    // Even the status the old code wrongly wrote resolves to free.
    expect(effective("free", "active")).toBe("free");
    // A genuine paid plan is unaffected by the change.
    expect(effective("growth", "active")).toBe("growth");
    // A cancelled paid plan still stops collecting.
    expect(effective("growth", "cancelled")).toBe("free");
  });
});
describe("needsPlanSync", () => {
  it("re-activates a paid plan Shopify reports active while ours is not", () => {
    // Stored growth/frozen showed Growth on the Plans page but enforced Free.
    expect(needsPlanSync({ plan: "growth", planStatus: "frozen" }, "growth")).toBe(true);
    expect(needsPlanSync({ plan: "growth", planStatus: "active" }, "growth")).toBe(false);
  });

  it("leaves a free shop's status alone when nothing changed", () => {
    expect(needsPlanSync({ plan: "free", planStatus: "cancelled" }, "free")).toBe(false);
  });

  it("syncs whenever the plan itself differs", () => {
    expect(needsPlanSync({ plan: "growth", planStatus: "active" }, "free")).toBe(true);
    expect(needsPlanSync({ plan: "free", planStatus: "active" }, "scale")).toBe(true);
  });
});

describe("isBillingNotEnabled", () => {
  it("recognises Shopify's refusal for an app without public distribution", () => {
    expect(isBillingNotEnabled("Apps without a public distribution cannot use the Billing API")).toBe(true);
    expect(isBillingNotEnabled("Custom apps cannot use the Billing API")).toBe(true);
  });

  it("leaves every other billing error to be shown as Shopify wrote it", () => {
    expect(isBillingNotEnabled("Price must be greater than zero")).toBe(false);
    expect(isBillingNotEnabled(undefined)).toBe(false);
    expect(isBillingNotEnabled("")).toBe(false);
  });
});

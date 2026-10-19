import { db } from "~/db.server";
import { getCompiledConfig } from "~/lib/surveys.server";
import { hasAudienceRules } from "@shared/survey-config";

/**
 * "Checkout check": what has to be true for buyers to see a survey on the
 * Thank-you page, each line answered from what the server actually observed.
 *
 * Only things the merchant can act on are listed. The block's state has three
 * levels, kept apart on purpose: a buyer's Thank-you page loaded it (proof it
 * runs in checkout), the merchant only said "It's already added" or the
 * checkout editor drew it (placed, but no buyer has seen it yet), or nothing.
 */

export type BlockState =
  | { kind: "buyer"; at: string }
  | { kind: "placed"; at: string }
  | { kind: "never" };

export type CheckoutCheck = {
  /** The survey buyers are shown first, before per-order rules. */
  survey: { name: string; audienceRules: boolean } | null;
  block: BlockState;
  /** Live surveys the plan does not serve (beyond its live share). */
  planHidden: number;
};

export async function runCheckoutCheck(shopId: string, surveyNames: ReadonlyMap<string, string>): Promise<CheckoutCheck> {
  const [config, live, shop, lastBuyerLoad] = await Promise.all([
    getCompiledConfig(shopId),
    db.survey.count({ where: { shopId, status: "active" } }),
    db.shop.findUnique({ where: { id: shopId }, select: { thankYouBlockSeenAt: true } }),
    db.checkoutLoad.findFirst({ where: { shopId }, orderBy: { at: "desc" }, select: { at: true } }),
  ]);

  const top = config.surveys.find((survey) => survey.placements.includes("thank_you")) ?? null;
  const block: BlockState = lastBuyerLoad
    ? { kind: "buyer", at: lastBuyerLoad.at.toISOString() }
    : shop?.thankYouBlockSeenAt
      ? { kind: "placed", at: shop.thankYouBlockSeenAt.toISOString() }
      : { kind: "never" };

  return {
    survey: top
      ? { name: surveyNames.get(top.id) ?? top.title, audienceRules: hasAudienceRules(top.targeting, top.paymentManualOnly) }
      : null,
    block,
    planHidden: Math.max(0, live - config.surveys.length),
  };
}

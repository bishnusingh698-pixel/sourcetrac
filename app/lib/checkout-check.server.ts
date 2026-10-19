import { db } from "~/db.server";
import { getBlockSeenAt, type CheckoutPlacement } from "~/lib/block-seen.server";
import { getCompiledConfig } from "~/lib/surveys.server";
import { hasAudienceRules } from "@shared/survey-config";

/**
 * "Checkout check": what has to be true for buyers to see a survey, page by
 * page, each line answered from what the server actually observed.
 *
 * Only things the merchant can act on are listed. The block's state has three
 * levels, kept apart on purpose: a buyer's page loaded it (proof it runs in
 * checkout), the merchant only said "It's already added" or the checkout editor
 * drew it (placed, but no buyer has seen it yet), or nothing.
 *
 * The Thank-you page is always checked. The Order status page is an optional
 * extra, so it is checked only once a live survey is set to show there or its
 * block has loaded.
 */

export type BlockState =
  | { kind: "buyer"; at: string }
  | { kind: "placed"; at: string }
  | { kind: "never" };

export type PageCheck = {
  placement: CheckoutPlacement;
  /** The survey buyers are shown first on this page, before per-order rules. */
  survey: { name: string; audienceRules: boolean } | null;
  block: BlockState;
};

export type CheckoutCheck = {
  pages: PageCheck[];
  /** Live surveys the plan does not serve (beyond its live share). */
  planHidden: number;
};

export async function runCheckoutCheck(shopId: string, surveyNames: ReadonlyMap<string, string>): Promise<CheckoutCheck> {
  const [config, live, seenAt, buyerLoads] = await Promise.all([
    getCompiledConfig(shopId),
    db.survey.count({ where: { shopId, status: "active" } }),
    getBlockSeenAt(shopId),
    db.checkoutLoad.groupBy({ by: ["placement"], where: { shopId }, _max: { at: true } }),
  ]);
  const lastBuyerLoad = new Map(buyerLoads.map((row) => [row.placement, row._max.at]));

  const pages = (["thank_you", "order_status"] as const).map((placement): PageCheck => {
    const top = config.surveys.find((survey) => survey.placements.includes(placement)) ?? null;
    const buyerAt = lastBuyerLoad.get(placement) ?? null;
    const placedAt = seenAt[placement];
    return {
      placement,
      survey: top
        ? { name: surveyNames.get(top.id) ?? top.title, audienceRules: hasAudienceRules(top.targeting, top.paymentManualOnly) }
        : null,
      block: buyerAt
        ? { kind: "buyer", at: buyerAt.toISOString() }
        : placedAt
          ? { kind: "placed", at: placedAt.toISOString() }
          : { kind: "never" },
    };
  });

  return {
    pages: pages.filter((page) => page.placement === "thank_you" || page.survey !== null || page.block.kind !== "never"),
    planHidden: Math.max(0, live - config.surveys.length),
  };
}

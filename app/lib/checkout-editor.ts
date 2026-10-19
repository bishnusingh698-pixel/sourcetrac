import type { Placement } from "@shared/survey-config";

/**
 * Shopify's checkout editor, where the SourceTrac block is added.
 *
 * Thank-you and Order status blocks only exist in the *checkout* editor
 * (Settings › Checkout › Customize), never the Online Store theme editor.
 * Shopify offers no link that opens the editor with an app block already
 * placed or selected. `?page=thank-you` opens it on the Thank-you page; for the
 * Order status page no `page` value could be verified, so the editor opens on
 * its default page. Every button that uses this sits next to the steps for
 * adding the block (`editor.store_step_block`, `editor.store_step_order_status`).
 */
export function checkoutEditorUrl(shopHandle: string, placement: Placement = "thank_you"): string {
  const base = `https://admin.shopify.com/store/${shopHandle}/settings/checkout/editor`;
  return placement === "thank_you" ? `${base}?page=thank-you` : base;
}

/** The checkout pages a survey is set to show on that have never shown its block. */
export function placementsMissingBlock(
  placements: readonly Placement[],
  seen: Partial<Record<Placement, boolean>>,
): Placement[] {
  return placements.filter((p) => (p === "thank_you" || p === "order_status") && !seen[p]);
}

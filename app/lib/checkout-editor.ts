/**
 * Shopify's checkout editor, opened on the Thank-you page, where the
 * SourceTrac block is added.
 *
 * The block only exists in the *checkout* editor (Settings › Checkout ›
 * Customize), never the Online Store theme editor. Shopify offers no link that
 * opens the editor with an app block already placed or selected, so
 * `?page=thank-you` is as close as a link gets: every button that opens it sits
 * next to the steps for adding the block (`editor.store_step_block`).
 */
export function checkoutEditorUrl(shopHandle: string): string {
  return `https://admin.shopify.com/store/${shopHandle}/settings/checkout/editor?page=thank-you`;
}

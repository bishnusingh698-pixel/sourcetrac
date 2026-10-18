/**
 * Where a charge's approval page may be opened from.
 *
 * The approval page refuses to render inside the admin iframe, so the Plans
 * page opens it in the top frame with `window.open(url, "_top")`, which App
 * Bridge allows. The library's `redirect(url, { target: "_top" })` answers a
 * fetch with a 401 carrying a reauthorize header instead, and through React
 * Router's data request that 401 reached the error screen ("401 Unauthorized")
 * rather than the approval page.
 *
 * Only Shopify's own https hosts pass, so a malformed answer can never send
 * the merchant elsewhere.
 */
export function isShopifyConfirmationUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  return url.hostname === "admin.shopify.com" || url.hostname.endsWith(".myshopify.com");
}

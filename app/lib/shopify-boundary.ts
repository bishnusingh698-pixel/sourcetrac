import { isRouteErrorResponse } from "react-router";

/**
 * Shopify's auth library answers some requests by *throwing* a 2xx HTML
 * response: the App Bridge page that redirects into the admin, exits the
 * iframe, or re-fetches a session token. React Router turns that throw into an
 * error, so it reaches the ErrorBoundary. Rendering it as a failure strands the
 * merchant on "200" instead of loading the page. That happens on every
 * top-level visit without `host` (the billing return URL, a bookmarked app URL,
 * the first open after install), and on a page switch whose data request
 * reached the server without a session token.
 */
export function isShopifyAuthResponse(error: unknown): boolean {
  return isRouteErrorResponse(error) && error.status >= 200 && error.status < 300;
}

/** The App Bridge page's HTML, carried as the thrown response's body. */
export function authResponseHtml(error: unknown): string {
  return isRouteErrorResponse(error) && typeof error.data === "string" ? error.data : "";
}

/** Query parameters a full page load needs to sign back into the admin. */
const EMBEDDED_PARAMS = ["shop", "host", "embedded", "locale"] as const;

/**
 * Where to send the frame when an App Bridge page arrives on a page switch.
 *
 * The page the merchant was opening, with its own query string, plus the
 * embedded parameters. A client-side move drops those from the address bar, so
 * they are taken from App Bridge's config first and the URL the document was
 * first loaded with second. `id_token` is never carried over: it is a few
 * minutes old at best, and the library fetches a fresh one when it is absent.
 */
export function embeddedReloadUrl(input: {
  pathname: string;
  search: string;
  bootSearch: string;
  config?: { shop?: string; host?: string; locale?: string };
}): string {
  const params = new URLSearchParams(input.search);
  params.delete("id_token");
  const boot = new URLSearchParams(input.bootSearch);
  for (const key of EMBEDDED_PARAMS) {
    const value = (key === "embedded" ? undefined : input.config?.[key]) ?? boot.get(key);
    if (value) params.set(key, value);
  }
  if (params.has("shop") && params.has("host")) params.set("embedded", "1");
  const query = params.toString();
  return query ? `${input.pathname}?${query}` : input.pathname;
}

/** How long a second App Bridge page counts as a loop rather than a new one. */
export const AUTH_RELOAD_WINDOW_MS = 20_000;

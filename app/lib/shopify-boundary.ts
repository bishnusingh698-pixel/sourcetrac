import { isRouteErrorResponse } from "react-router";

/**
 * Shopify's auth library answers some document requests by *throwing* a 2xx
 * HTML response: the App Bridge page that redirects into the admin, exits the
 * iframe, or re-fetches a session token. React Router turns that throw into an
 * error, so it reaches the ErrorBoundary. It must be rendered verbatim with
 * `boundary.error`,
 * exactly as the official template does — rendering it as a failure strands
 * the merchant on "200" instead of loading the dashboard. That happens on every
 * top-level visit without `host` (the billing return URL, a bookmarked app URL,
 * the first open after install), which is when the app "does not show up".
 */
export function isShopifyAuthResponse(error: unknown): boolean {
  return isRouteErrorResponse(error) && error.status >= 200 && error.status < 300;
}

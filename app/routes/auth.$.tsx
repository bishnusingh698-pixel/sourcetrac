import { redirect } from "react-router";

import { safeInternalPath } from "~/lib/http.server";
import { logger } from "~/lib/logger";
import { ensureShop } from "~/lib/provision.server";
import { authenticate } from "~/shopify.server";

/**
 * OAuth entry and callback (`/auth/*`).
 *
 * `authPathPrefix: "/auth"` means the official wrapper owns the whole flow.
 * On success we make sure our own `shops` row exists, because every public
 * endpoint resolves the merchant through `findShopByDomain`.
 */
export const loader = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);

  // Throwing a Response is how authenticate.admin signals "go to Shopify" or
  // "re-auth"; that throw must propagate untouched.
  const { session } = await authenticate.admin(request);

  // The merchant is authenticated; our own bookkeeping must not turn that into
  // a 500 inside the admin (a database blip, Neon waking). `afterAuth` already
  // provisioned on token exchange (so this only provisions a shop it missed,
  // without a second identity call), and the admin loaders retry it.
  try {
    await ensureShop(session);
  } catch (error) {
    logger.error("auth_route_provision_failed", {
      shop_domain: session.shop,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }

  // Carry the embedded context (`shop`, `host`, `embedded`) into the app, or
  // App Bridge has to bounce the merchant through another redirect to get it.
  const target = new URL(safeInternalPath(url.searchParams.get("redirect") ?? "/app"), url.origin);
  for (const key of ["shop", "host", "embedded"]) {
    const value = url.searchParams.get(key);
    if (value && !target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  return redirect(`${target.pathname}${target.search}`);
};

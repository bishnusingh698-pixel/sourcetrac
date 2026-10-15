import { redirect } from "react-router";

import { safeInternalPath } from "~/lib/http.server";
import { provisionShop } from "~/lib/provision.server";
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

  await provisionShop(session);

  // Carry the embedded context (`shop`, `host`, `embedded`) into the app, or
  // App Bridge has to bounce the merchant through another redirect to get it.
  const target = new URL(safeInternalPath(url.searchParams.get("redirect") ?? "/app"), url.origin);
  for (const key of ["shop", "host", "embedded"]) {
    const value = url.searchParams.get(key);
    if (value && !target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  return redirect(`${target.pathname}${target.search}`);
};

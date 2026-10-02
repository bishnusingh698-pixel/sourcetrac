import { redirect } from "react-router";

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

  const target = url.searchParams.get("redirect") ?? "/app";
  return redirect(safeInternalPath(target));
};

/** Only ever redirect to our own paths (no open redirect via `?redirect=`). */
function safeInternalPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/app";
  return value;
}

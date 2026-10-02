import { data } from "react-router";

import { isSupportedLanguage, type LanguageCode } from "~/lib/i18n";
import { requireShopByDomain as requireShop, setLanguage } from "~/lib/shop.server";
import { authenticate } from "~/shopify.server";

/**
 * Resource route for changing the admin UI language.
 *
 * This exists as its own route rather than living on the shell's action because
 * the language picker is rendered on every admin page, and a `<fetcher>` without
 * an explicit `action` posts to the *nearest* route in the tree — not to the
 * shell that owns the action. On `/app/settings` that would have posted
 * `{ language }` to the settings action, which expects the whole survey form,
 * and shown the merchant a validation error instead of switching language.
 *
 * A resource route has no default export, so it never renders. React Router
 * revalidates all active loaders after the fetcher submit, which re-reads the
 * merchant's saved preference and re-renders the app in the new language.
 */
export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = await requireShop(session.shop);

  const form = await request.formData();
  const requested = form.get("language");

  if (typeof requested !== "string" || !isSupportedLanguage(requested)) {
    // 422 rather than a throw: React Router would render an error boundary over
    // whatever page the merchant was standing on.
    return data({ ok: false as const, language: null }, { status: 422 });
  }

  await setLanguage(shop.id, requested as LanguageCode);

  return data({ ok: true as const, language: requested as LanguageCode });
}

/**
 * A GET to this URL is not meaningful. Loaders run for prefetches and for
 * navigations, so answering with 405 keeps a stray link from rendering a blank
 * page in place of whatever the merchant was looking at.
 */
export function loader() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

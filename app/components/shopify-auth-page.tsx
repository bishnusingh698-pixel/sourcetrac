import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";

import { AUTH_RELOAD_WINDOW_MS, authResponseHtml, embeddedReloadUrl } from "~/lib/shopify-boundary";

/**
 * Renders the App Bridge page Shopify's auth library throws (see
 * `isShopifyAuthResponse`), in place of the library's `boundary.error`.
 *
 * Two cases, and the library handles neither on the client:
 *
 * - **The first document load.** The server rendered the page, its scripts
 *   already ran, and hydration must produce the same markup. `boundary.error`
 *   recognises the error by `constructor.name === "ErrorResponseImpl"`, which
 *   the production bundle minifies away, so in the browser it threw again and
 *   the merchant got the root error screen reading "200".
 * - **A page switch.** The data request came back as that HTML page. Scripts
 *   set through `innerHTML` never run, so rendering it does nothing. The only
 *   way through is a real page load of the page the merchant was opening,
 *   which signs in with a fresh session token on the way.
 *
 * A second App Bridge page within `AUTH_RELOAD_WINDOW_MS` is a loop, not a
 * hiccup, and shows `fallback` instead of reloading again.
 */
let documentHydrated = false;

/** Called once the first render has committed; later renders are page switches. */
export function markDocumentHydrated(): void {
  documentHydrated = true;
}

// The address the document was loaded with. It still carries `shop` and
// `host`; client-side moves drop them from the address bar.
const BOOT_SEARCH = typeof window === "undefined" ? "" : window.location.search;
const RELOAD_KEY = "sourcetrac:auth-reload";

/** An app path with the embedded parameters a full page load needs. */
export function embeddedHref(pathname: string, search: string): string {
  return embeddedReloadUrl({
    pathname,
    search,
    bootSearch: BOOT_SEARCH,
    config: typeof window === "undefined" ? undefined : window.shopify?.config,
  });
}

export function ShopifyAuthPage({ error, fallback }: { error: unknown; fallback: ReactNode }) {
  const [fromServer] = useState(() => typeof window === "undefined" || !documentHydrated);
  const [gaveUp, setGaveUp] = useState(false);
  const location = useLocation();

  useEffect(() => {
    markDocumentHydrated();
    if (fromServer) return;
    if (recentlyReloaded()) {
      setGaveUp(true);
      return;
    }
    rememberReload();
    window.location.replace(embeddedHref(location.pathname, location.search));
  }, [fromServer, location.pathname, location.search]);

  if (fromServer) return <div dangerouslySetInnerHTML={{ __html: authResponseHtml(error) || "Handling response" }} />;
  return gaveUp ? <>{fallback}</> : null;
}

function recentlyReloaded(): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(RELOAD_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < AUTH_RELOAD_WINDOW_MS;
  } catch {
    return false;
  }
}

function rememberReload(): void {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // No storage (private window, blocked site data): reload anyway. Without
    // the stamp a loop is possible, but a stuck "200" screen is certain.
  }
}

/**
 * The "200" screen on a page switch.
 *
 * Shopify's auth library answers a request it cannot sign in by throwing its
 * App Bridge page as a 200 response. The library's own `boundary.error`
 * recognises that by `constructor.name === "ErrorResponseImpl"`, a name the
 * production bundle minifies away, so in the browser it threw again and the
 * merchant saw "200" with a "Go to the dashboard" link. `ShopifyAuthPage`
 * replaces it: the server's page hydrates unchanged, and a page switch reloads
 * the page with a fresh session instead of showing anything.
 */
import "../helpers/dom-globals";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { markDocumentHydrated, ShopifyAuthPage } from "~/components/shopify-auth-page";
import { embeddedReloadUrl, isShopifyAuthResponse } from "~/lib/shopify-boundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** React Router's error response as the minified client bundle names it. */
class qe {
  internal = false;
  constructor(
    public status: number,
    public statusText: string,
    public data: unknown,
  ) {}
}
const APP_BRIDGE_HTML = '<script data-api-key="k" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>';
const minified = new qe(200, "", APP_BRIDGE_HTML);

const read = (relative: string) => readFileSync(join(__dirname, "../..", relative), "utf8");

function mount(path: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(ShopifyAuthPage, {
          error: minified,
          fallback: createElement("p", { id: "fallback" }, "Your session needs refreshing."),
        }),
      },
    ],
    { initialEntries: [path] },
  );
  act(() => root.render(createElement(RouterProvider, { router })));
  return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { shopify?: unknown }).shopify;
});

describe("the App Bridge page in an error boundary", () => {
  it("is recognised from its shape, whatever the class is called", () => {
    expect(isShopifyAuthResponse(minified)).toBe(true);
  });

  it("is what the library's boundary fails on in the browser", () => {
    expect(() => boundary.error(minified)).toThrow();
  });

  it("renders the server's App Bridge page, on the server and when it hydrates", () => {
    const html = renderToString(
      createElement(RouterProvider, {
        router: createMemoryRouter([{ path: "*", element: createElement(ShopifyAuthPage, { error: minified, fallback: null }) }]),
      }),
    );
    expect(html).toContain("app-bridge.js");

    const { container, unmount } = mount("/app/results");
    expect(container.innerHTML).toContain("app-bridge.js");
    unmount();
  });

  it("reloads the page being opened, signed in, on a page switch", () => {
    markDocumentHydrated();
    (window as { shopify?: unknown }).shopify = { config: { shop: "demo.myshopify.com", host: "aG9zdA" } };
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    window.sessionStorage.clear();

    const { container, unmount } = mount("/app/results?survey=s1&id_token=old");
    expect(container.innerHTML).not.toContain("200");
    expect(replace).toHaveBeenCalledTimes(1);
    const target = new URL(String(replace.mock.calls[0]?.[0]), "https://app.test");
    expect(target.pathname).toBe("/app/results");
    expect(target.searchParams.get("survey")).toBe("s1");
    expect(target.searchParams.get("shop")).toBe("demo.myshopify.com");
    expect(target.searchParams.get("host")).toBe("aG9zdA");
    expect(target.searchParams.get("embedded")).toBe("1");
    expect(target.searchParams.has("id_token")).toBe(false);
    unmount();
  });

  it("shows the fallback instead of reloading again straight away", () => {
    markDocumentHydrated();
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    window.sessionStorage.setItem("sourcetrac:auth-reload", String(Date.now()));

    const { container, unmount } = mount("/app/results");
    expect(replace).not.toHaveBeenCalled();
    expect(container.querySelector("#fallback")).not.toBeNull();
    unmount();
  });

  it("is wired into both error boundaries in place of the library's", () => {
    for (const file of ["app/routes/app.tsx", "app/root.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("<ShopifyAuthPage error={error}");
      expect(source, file).not.toContain("boundary.error(");
    }
    expect(read("app/root.tsx")).toContain("useEffect(markDocumentHydrated, []);");
  });
});

describe("embeddedReloadUrl", () => {
  it("takes shop and host from the URL the document was loaded with", () => {
    expect(
      embeddedReloadUrl({
        pathname: "/app/plans",
        search: "",
        bootSearch: "?embedded=1&host=aG9zdA&id_token=x&locale=de&shop=demo.myshopify.com",
      }),
    ).toBe("/app/plans?shop=demo.myshopify.com&host=aG9zdA&embedded=1&locale=de");
  });

  it("prefers App Bridge's config, and leaves a bare path alone when nothing is known", () => {
    expect(
      embeddedReloadUrl({
        pathname: "/app",
        search: "?range=30",
        bootSearch: "?shop=old.myshopify.com&host=b2xk",
        config: { shop: "demo.myshopify.com", host: "aG9zdA" },
      }),
    ).toBe("/app?range=30&shop=demo.myshopify.com&host=aG9zdA&embedded=1");
    expect(embeddedReloadUrl({ pathname: "/app", search: "", bootSearch: "" })).toBe("/app");
  });
});

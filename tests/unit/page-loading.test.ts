/**
 * Between admin pages, the Shopify admin's own progress bar runs while the next
 * page's loader does (App Bridge Loading API), and stops when it is done. A
 * form submission does not start it: its button already shows a spinner.
 */
import "../helpers/dom-globals";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageLoading } from "~/components/page-loading";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let release: () => void = () => undefined;
const loading = vi.fn();

beforeEach(() => {
  loading.mockReset();
  (window as unknown as { shopify: unknown }).shopify = { loading };
});

afterEach(() => {
  act(() => root.unmount());
  delete (window as unknown as { shopify?: unknown }).shopify;
});

describe("PageLoading", () => {
  it("runs the admin's progress bar while the next page loads, then stops it", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app",
          element: createElement("div", null, createElement(PageLoading), createElement(Outlet)),
          children: [
            { path: "a", element: createElement("p", null, "a") },
            {
              path: "b",
              loader: () => new Promise<null>((resolve) => (release = () => resolve(null))),
              element: createElement("p", null, "b"),
            },
          ],
        },
      ],
      { initialEntries: ["/app/a"] },
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(RouterProvider, { router })));
    loading.mockReset();

    await act(async () => {
      void router.navigate("/app/b");
    });
    expect(loading).toHaveBeenLastCalledWith(true);

    await act(async () => release());
    expect(router.state.location.pathname).toBe("/app/b");
    expect(loading).toHaveBeenLastCalledWith(false);
  });
});

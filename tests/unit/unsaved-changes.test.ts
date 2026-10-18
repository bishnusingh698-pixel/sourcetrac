/**
 * The survey editor must not be left with unsaved edits.
 *
 * `UnsavedChangesGuard` is mounted for real inside a data router, and the test
 * navigates the way the app does (a router navigation, which is also what App
 * Bridge's `shopify:navigate` turns a sidebar tap into). A guard that stops
 * blocking, or blocks the editor's own save, fails here.
 */
import "../helpers/dom-globals";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { leavesPage, SAVE_BAR_ID, UnsavedChangesGuard } from "~/components/unsaved-changes";
import { createTranslator } from "~/lib/i18n";

const t = createTranslator("en");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Harness = { setDirty: (v: boolean) => void; saves: number; discards: number };

function Editor({ harness }: { harness: Harness }) {
  const [dirty, setDirty] = useState(false);
  harness.setDirty = setDirty;
  const navigate = useNavigate();
  return createElement(
    "div",
    null,
    createElement(UnsavedChangesGuard, {
      dirty,
      saving: false,
      saveLabel: "Save draft",
      onSave: () => {
        harness.saves += 1;
      },
      onDiscard: () => {
        harness.discards += 1;
        setDirty(false);
      },
      t,
    }),
    createElement("button", { id: "notice", onClick: () => navigate("/app/surveys/s1?saved=1") }, "notice"),
  );
}

let root: Root;
let container: HTMLElement;
let saveBar: { show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> };

function mount() {
  const harness: Harness = { setDirty: () => {}, saves: 0, discards: 0 };
  const router = createMemoryRouter(
    [
      { path: "/app/surveys/:id", element: createElement(Editor, { harness }) },
      { path: "/app/surveys", element: createElement("p", null, "list") },
    ],
    { initialEntries: ["/app/surveys/s1"] },
  );
  act(() => root.render(createElement(RouterProvider, { router })));
  return { router, harness };
}

/** The banner shown while a move away is held, if any. */
function heldBanner(): Element | null {
  return container.querySelector('[role="alert"] s-banner');
}

/** The s-button in the held-navigation banner whose label is `label`. */
function bannerButton(label: string): HTMLElement {
  const found = [...container.querySelectorAll("s-button")].find((el) => el.textContent === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found as HTMLElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  saveBar = { show: vi.fn(), hide: vi.fn() };
  (window as unknown as { shopify: unknown }).shopify = { saveBar };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { shopify?: unknown }).shopify;
});

describe("leavesPage", () => {
  it("counts only a change of page", () => {
    expect(leavesPage({ pathname: "/app/surveys/s1" }, { pathname: "/app/surveys" })).toBe(true);
    // The editor's own post, and its ?saved=1 redirect, stay on the page.
    expect(leavesPage({ pathname: "/app/surveys/s1" }, { pathname: "/app/surveys/s1" })).toBe(false);
  });
});

describe("UnsavedChangesGuard", () => {
  it("lets a clean editor leave freely", async () => {
    const { router } = mount();
    await act(() => router.navigate("/app/surveys"));
    expect(router.state.location.pathname).toBe("/app/surveys");
  });

  it("holds a move away with unsaved changes and offers save, discard or stay", async () => {
    const { router, harness } = mount();
    act(() => harness.setDirty(true));
    await act(() => router.navigate("/app/surveys"));

    expect(router.state.location.pathname).toBe("/app/surveys/s1");
    expect(heldBanner()?.getAttribute("heading")).toBe(t("editor.leave_title"));

    // Keep editing: the banner goes, the merchant stays.
    act(() => bannerButton(t("editor.leave_stay")).click());
    expect(heldBanner()).toBeNull();
    expect(router.state.location.pathname).toBe("/app/surveys/s1");

    // Save from the banner: the save runs and nobody leaves yet.
    await act(() => router.navigate("/app/surveys"));
    act(() => bannerButton("Save draft").click());
    expect(harness.saves).toBe(1);
    expect(router.state.location.pathname).toBe("/app/surveys/s1");

    // Discard and leave: the held move goes through.
    await act(() => router.navigate("/app/surveys"));
    await act(async () => bannerButton(t("editor.leave_discard")).click());
    expect(router.state.location.pathname).toBe("/app/surveys");
  });

  it("never holds the editor's own same-page navigation", async () => {
    const { router, harness } = mount();
    act(() => harness.setDirty(true));
    await act(async () => (container.querySelector("#notice") as HTMLElement).click());
    expect(router.state.location.search).toBe("?saved=1");
    expect(heldBanner()).toBeNull();
  });

  it("lets the held move go once the changes are discarded from the save bar", async () => {
    const { router, harness } = mount();
    act(() => harness.setDirty(true));
    await act(() => router.navigate("/app/surveys"));
    const discard = [...container.querySelectorAll(`ui-save-bar#${SAVE_BAR_ID} button`)].find(
      (el) => el.textContent === t("editor.discard_changes"),
    ) as HTMLElement;
    await act(async () => discard.click());
    expect(harness.discards).toBe(1);
    expect(router.state.location.pathname).toBe("/app/surveys");
  });

  it("shows Shopify's save bar while dirty and takes it down when clean or gone", () => {
    const { harness } = mount();
    act(() => harness.setDirty(true));
    expect(saveBar.show).toHaveBeenLastCalledWith(SAVE_BAR_ID);
    act(() => harness.setDirty(false));
    expect(saveBar.hide).toHaveBeenLastCalledWith(SAVE_BAR_ID);
    saveBar.hide.mockClear();
    act(() => root.unmount());
    expect(saveBar.hide).toHaveBeenCalledWith(SAVE_BAR_ID);
    root = createRoot(container);
  });

  it("asks before a reload only while dirty", () => {
    const { harness } = mount();
    const fire = () => {
      const event = new window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire()).toBe(false);
    act(() => harness.setDirty(true));
    expect(fire()).toBe(true);
  });
});

describe("the survey editor", () => {
  const source = readFileSync(join(process.cwd(), "app/routes/app.surveys.$id.tsx"), "utf8");

  it("mounts the guard with its real dirty state", () => {
    expect(source).toMatch(/import \{ UnsavedChangesGuard \} from "~\/components\/unsaved-changes"/);
    expect(source).toMatch(/<UnsavedChangesGuard\s+dirty=\{dirty\}/);
    expect(source).toMatch(/onSave=\{\(\) => post\("save"\)\}/);
    expect(source).toMatch(/onDiscard=\{discardChanges\}/);
  });
});

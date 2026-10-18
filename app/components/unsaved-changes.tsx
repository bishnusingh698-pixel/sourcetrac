import { useEffect, useRef } from "react";
import { useBlocker } from "react-router";

import { Banner } from "~/components/admin-ui";
import type { TFn } from "~/components/survey-editor";

/**
 * Keeps a merchant from leaving the survey editor with unsaved edits.
 *
 * A merchant who builds a survey and then taps another page could reasonably
 * expect the work to be kept. It is not: the editor holds it in local state
 * until Save. So while there are unsaved changes, every way out is closed until
 * they save or discard:
 *
 * - **Shopify's contextual save bar** (`ui-save-bar`, App Bridge) takes over
 *   the admin's top bar with Save and Discard. While it shows, Shopify blocks
 *   navigation in the admin itself (its sidebar, the app list, back).
 * - **A router blocker** stops every in-app move: the top menu, "Back to
 *   surveys", "See answers" and the sidebar links, which App Bridge hands to
 *   React Router through `shopify:navigate`. The blocked move is held, and a
 *   banner at the top of the page offers Save, "Discard and leave" or "Keep
 *   editing". Saving posts to this same page, so it is never blocked.
 * - **`beforeunload`** covers a reload or closing the tab.
 */
export const SAVE_BAR_ID = "survey-editor-save-bar";

/** App Bridge reads `variant` off the save bar's buttons; React's button type has no such attribute. */
const PRIMARY = { variant: "primary" } as const;

/**
 * Whether a navigation leaves the editor. Only a change of page counts: the
 * editor's own form posts and its `?saved=1`-style notices stay on the same
 * pathname and must never be held.
 */
export function leavesPage(current: { pathname: string }, next: { pathname: string }): boolean {
  return current.pathname !== next.pathname;
}

export function UnsavedChangesGuard({
  dirty,
  saving,
  saveLabel,
  onSave,
  onDiscard,
  t,
}: {
  dirty: boolean;
  /** A save is in flight; its redirect must not be stopped and nothing should ask. */
  saving: boolean;
  saveLabel: string;
  onSave: () => void;
  onDiscard: () => void;
  t: TFn;
}) {
  const guarding = dirty && !saving;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => guarding && leavesPage(currentLocation, nextLocation));

  // Shopify's save bar follows the unsaved state, and is always taken down when
  // the editor goes away so it never lingers over another page.
  useEffect(() => {
    const bar = window.shopify?.saveBar;
    if (!bar) return;
    if (dirty) bar.show(SAVE_BAR_ID);
    else bar.hide(SAVE_BAR_ID);
  }, [dirty]);
  useEffect(() => () => window.shopify?.saveBar?.hide(SAVE_BAR_ID), []);

  useEffect(() => {
    if (!guarding) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers only prompt when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [guarding]);

  // The changes were saved or discarded while a move was held: let it go.
  useEffect(() => {
    if (blocker.state === "blocked" && !dirty) blocker.proceed();
  }, [blocker, dirty]);

  // The banner sits at the top of a long page; bring it into view, since the
  // tap that triggered it may have come from the bottom or the sidebar.
  const bannerRef = useRef<HTMLDivElement>(null);
  const held = blocker.state === "blocked";
  useEffect(() => {
    if (held) bannerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [held]);

  return (
    <>
      <ui-save-bar id={SAVE_BAR_ID}>
        <button {...PRIMARY} onClick={onSave}>
          {saveLabel}
        </button>
        <button onClick={onDiscard}>{t("editor.discard_changes")}</button>
      </ui-save-bar>
      {held ? (
        <div ref={bannerRef} role="alert">
          <Banner tone="warning" heading={t("editor.leave_title")}>
            <s-stack gap="small">
              <s-text>{t("editor.leave_body")}</s-text>
              <s-stack direction="inline" gap="small">
                <s-button
                  variant="primary"
                  onClick={() => {
                    blocker.reset?.();
                    onSave();
                  }}
                >
                  {saveLabel}
                </s-button>
                <s-button tone="critical" onClick={() => blocker.proceed?.()}>
                  {t("editor.leave_discard")}
                </s-button>
                <s-button variant="tertiary" onClick={() => blocker.reset?.()}>
                  {t("editor.leave_stay")}
                </s-button>
              </s-stack>
            </s-stack>
          </Banner>
        </div>
      ) : null}
    </>
  );
}

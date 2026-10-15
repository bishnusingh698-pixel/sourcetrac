import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { activeNavPath, NAV } from "~/lib/nav";

/**
 * The app's own menu, a bar across the top of every admin page.
 *
 * Shopify's sidebar (`<s-app-nav>`) lists the app's pages too, but only on
 * desktop and only up to seven; on a phone it hides behind the app title menu.
 * This bar is always visible, holds every page, and marks the current one.
 *
 * Items are `s-clickable` links, so a tap goes through App Bridge's
 * `shopify:navigate` and React Router like every other link in the app: no full
 * reload, and the embedded session is kept.
 *
 * On a wide frame the items wrap onto a second row when a translation is long.
 * On a phone the bar is one row that scrolls sideways (see `.st-topnav-track`),
 * and the current page's item is scrolled into view, because three stacked rows
 * of links above every page would push the content off the first screen.
 */
export function TopNav({ t }: { t: TFunction }) {
  const { pathname } = useLocation();
  const active = activeNavPath(pathname);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    const item = track?.querySelector<HTMLElement>("[data-current='true']");
    if (!track || !item) return;
    // Only the bar's own horizontal scroll moves. `scrollIntoView` could also
    // scroll the page, which on a phone would jump past the content.
    const trackBox = track.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    if (itemBox.left < trackBox.left || itemBox.right > trackBox.right) {
      track.scrollLeft += itemBox.left - trackBox.left - 8;
    }
  }, [active]);

  return (
    <nav aria-label={t("nav.label")}>
      <s-box padding="small-200" border="base" borderRadius="large" background="base">
        <div className="st-topnav-track" ref={trackRef}>
          {NAV.map((item) => {
            const current = item.to === active;
            return (
              <s-clickable
                key={item.to}
                href={item.to}
                // `small` on both axes keeps each link a comfortable tap
                // target on a phone without making the bar tall on desktop.
                padding="small"
                borderRadius="base"
                background={current ? "strong" : "transparent"}
                data-current={current ? "true" : "false"}
              >
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-icon type={item.icon} color={current ? "base" : "subdued"} />
                  <s-text type={current ? "strong" : "generic"} color={current ? "base" : "subdued"}>
                    {t(item.key)}
                  </s-text>
                  {/* Heard, not seen: which item is the page you are on. */}
                  {current ? <s-text accessibilityVisibility="exclusive">{t("nav.current")}</s-text> : null}
                </s-stack>
              </s-clickable>
            );
          })}
        </div>
      </s-box>
    </nav>
  );
}

import { useLocation } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { activeNavPath, NAV } from "~/lib/nav";

/**
 * The app's own menu, a grid of icon tiles across the top of every admin page.
 *
 * Shopify's sidebar (`<s-app-nav>`) lists the app's pages too, but only on
 * desktop and only up to seven; on a phone it hides behind the app title menu.
 * This menu is always visible, holds every page, and marks the current one.
 *
 * Each tile is an icon with its label underneath, the same on a phone and on
 * desktop. Nothing scrolls: the tiles sit in a grid of 3, 5 or 9 columns
 * depending on the frame's width (see `.st-topnav-grid`), so every page is in
 * view at once and the rows always fill evenly. The label wraps onto a second
 * line inside its own tile rather than running into the next one.
 *
 * Items are `s-clickable` links, so a tap goes through App Bridge's
 * `shopify:navigate` and React Router like every other link in the app: no full
 * reload, and the embedded session is kept.
 */
export function TopNav({ t }: { t: TFunction }) {
  const { pathname } = useLocation();
  const active = activeNavPath(pathname);

  return (
    <nav aria-label={t("nav.label")}>
      <s-box padding="small-200" border="base" borderRadius="large" background="base">
        <ul className="st-topnav-grid">
          {NAV.map((item) => {
            const current = item.to === active;
            return (
              <li key={item.to} className="st-topnav-cell">
                <s-clickable
                  href={item.to}
                  padding="small-200"
                  borderRadius="base"
                  inlineSize="100%"
                  blockSize="100%"
                  background={current ? "strong" : "transparent"}
                  data-current={current ? "true" : "false"}
                >
                  <span className="st-topnav-tile">
                    <s-icon type={item.icon} color={current ? "base" : "subdued"} />
                    <s-text
                      fontSize="small"
                      type={current ? "strong" : "generic"}
                      color={current ? "base" : "subdued"}
                    >
                      {t(item.key)}
                    </s-text>
                    {/* Heard, not seen: which item is the page you are on. */}
                    {current ? <s-text accessibilityVisibility="exclusive">{t("nav.current")}</s-text> : null}
                  </span>
                </s-clickable>
              </li>
            );
          })}
        </ul>
      </s-box>
    </nav>
  );
}

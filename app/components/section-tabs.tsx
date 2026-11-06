import { Link, useLocation } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { SECTION_TABS, sectionFor } from "~/lib/nav";

/**
 * The pages of the current section, as one compact row under the page title:
 * Surveys (My surveys, Templates, Quick start), Analytics (Channels, Survey
 * results) and Responses (Answers, Export). Rendered once, by the admin shell,
 * and only on those pages: Shopify's own navigation is the app's menu, and the
 * body must not repeat it (see the note on `NAV`).
 *
 * Each item is a small icon beside its label, so a row of three stays one line
 * on a phone; a long translation wraps onto the next line instead of scrolling
 * sideways or overlapping. Plain React Router links (`.st-sectionnav-link`), so
 * a tap is an in-app navigation that keeps the embedded session, never a full
 * reload. The current page carries `aria-current="page"`, which screen readers
 * announce. Query strings (a range, a survey) are not carried over: each page
 * has its own filters.
 */
export function SectionNav({ t }: { t: TFunction }) {
  const { pathname } = useLocation();
  const section = sectionFor(pathname);
  if (!section) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  return (
    <nav aria-label={t("tabs.label")} className="st-sectionnav">
      <ul className="st-sectionnav-list">
        {SECTION_TABS[section].map((tab) => {
          const current = tab.to === path;
          return (
            <li key={tab.to}>
              <Link
                to={tab.to}
                prefetch="intent"
                className={current ? "st-sectionnav-link st-sectionnav-link--current" : "st-sectionnav-link"}
                aria-current={current ? "page" : undefined}
              >
                <s-icon type={tab.icon} size="small" color={current ? "base" : "subdued"} />
                <span>{t(tab.labelKey)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

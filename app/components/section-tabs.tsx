import { Link, useLocation } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { SECTION_TABS, type SectionTabsKey } from "~/lib/nav";

/**
 * The pages of one section (U1), as tabs under the page title: Surveys has My
 * surveys, Templates and Quick start; Analytics has Channels and Survey
 * results; Responses has Answers and Export.
 *
 * Plain links styled as tabs (`.st-tabs`), so a tap is an ordinary in-app
 * navigation that keeps the embedded session, and the row wraps on a phone
 * rather than scrolling sideways. The current tab is marked for screen readers
 * with `aria-current`. Query strings (a range, a survey) are not carried over:
 * each tab has its own filters.
 */
export function SectionTabs({ section, t }: { section: SectionTabsKey; t: TFunction }) {
  const { pathname } = useLocation();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (
    <nav aria-label={t("tabs.label")} className="st-tabs">
      {SECTION_TABS[section].map((tab) => {
        const current = tab.to === path;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            prefetch="intent"
            className={current ? "st-tab st-tab--current" : "st-tab"}
            aria-current={current ? "page" : undefined}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}

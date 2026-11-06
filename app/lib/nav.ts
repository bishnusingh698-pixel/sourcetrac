/**
 * Every place a merchant can go in the app, in one list.
 *
 * Shopify's own admin navigation (`<s-app-nav>`) is the app's menu: the left
 * sidebar on desktop, the app title's menu on a phone. It shows the items
 * marked `sidebar`; past seven, Shopify folds the rest under "View more", and
 * none may repeat the home page (the app name itself links to it), so Home
 * stays out.
 *
 * The page body does not repeat that menu. Shopify's app design guidelines
 * ask apps not to replicate the app nav in the app body, and Built for
 * Shopify counts an app's own navigation menu as an audit failure (the
 * in-page tile grid this replaced did exactly that). Inside the body there
 * is only secondary navigation: the pages of the current section
 * (`SectionNav`), and a breadcrumb in the title bar on a detail page.
 *
 * `key` is an i18next key, not display text: this is a module-level constant
 * shared by every request, so a translated string could never be stored here
 * without leaking one merchant's language into the next tenant's page. Keys are
 * resolved per render.
 *
 * `icon` is a Polaris icon name.
 */
export type NavItem = {
  to: string;
  key: string;
  icon: string;
  sidebar: boolean;
  /**
   * Other pages that belong to this section, shown as tabs on its pages
   * (`SectionNav`). They light up this item, never one of their own.
   */
  also?: readonly string[];
};

/**
 * Seven sections (U1, 2026-10-25). The menu used to list ten pages, and
 * merchants could not tell Dashboard, Channel report and Results apart. Now:
 *
 * - Home: the dashboard, or the setup guide until the first answer.
 * - Surveys: the list, with Templates and Quick start as tabs.
 * - Analytics: Channels (where buyers come from, and the revenue) and Survey
 *   results (every question, NPS and CSAT), as two tabs of one section.
 * - Responses: every answer, with Export as a tab.
 * - Plans, Settings, Help.
 *
 * The page URLs did not change, so bookmarks and links keep working.
 */
export const NAV = [
  { to: "/app", key: "nav.home", icon: "home", sidebar: false },
  { to: "/app/surveys", key: "nav.surveys", icon: "clipboard-checklist", sidebar: true },
  { to: "/app/dashboard", key: "nav.analytics", icon: "chart-vertical", sidebar: true, also: ["/app/results"] },
  { to: "/app/responses", key: "nav.responses", icon: "chat", sidebar: true, also: ["/app/export"] },
  { to: "/app/plans", key: "nav.plans", icon: "plan", sidebar: true },
  { to: "/app/settings", key: "nav.preferences", icon: "settings", sidebar: true },
  { to: "/app/help", key: "nav.help", icon: "question-circle", sidebar: true },
] as const satisfies ReadonlyArray<NavItem>;

/** Whether `path` is `prefix` or a page under it (the prefix ends at a `/`). */
function under(path: string, prefix: string): boolean {
  return prefix === "/app" ? path === "/app" : path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The `to` of the item the current page belongs to, or null (the privacy page
 * has no item of its own).
 *
 * A page belongs to the item whose path (or one of its `also` paths) is its
 * longest whole-segment prefix, so the survey editor and the template library
 * (`/app/surveys/...`) light up Surveys, Survey results lights up Analytics,
 * and the export CSV lights up Responses. `/app` itself matches only exactly,
 * or every page would light up Home. `/app/surveysx` does not match
 * `/app/surveys`: the prefix has to end at a `/`.
 */
export function activeNavPath(
  pathname: string,
  items: ReadonlyArray<Pick<NavItem, "to"> & { also?: readonly string[] }> = NAV,
): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: { to: string; length: number } | null = null;
  for (const item of items) {
    for (const prefix of [item.to, ...(item.also ?? [])]) {
      if (under(path, prefix) && (best === null || prefix.length > best.length)) best = { to: item.to, length: prefix.length };
    }
  }
  return best?.to ?? null;
}

/**
 * The pages inside each section, in order. `labelKey` is resolved per render;
 * `icon` is a Polaris icon name, drawn small beside the label. A page lists
 * here only if it is one of its section's pages; the survey editor and the CSV
 * downloads are not.
 */
export const SECTION_TABS = {
  surveys: [
    { to: "/app/surveys", labelKey: "tabs.my_surveys", icon: "list-bulleted" },
    { to: "/app/surveys/library", labelKey: "tabs.templates", icon: "page-list" },
    { to: "/app/surveys/quick-start", labelKey: "tabs.quick_start", icon: "bolt" },
  ],
  analytics: [
    { to: "/app/dashboard", labelKey: "tabs.channels", icon: "chart-vertical" },
    { to: "/app/results", labelKey: "tabs.results", icon: "chart-horizontal" },
  ],
  responses: [
    { to: "/app/responses", labelKey: "tabs.answers", icon: "chat" },
    { to: "/app/export", labelKey: "tabs.export", icon: "export" },
  ],
} as const;

export type SectionTabsKey = keyof typeof SECTION_TABS;

function trimPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/**
 * The section whose page list to show on `pathname`, or null. Only on one of
 * the section's own pages: a detail page (the survey editor) gets a
 * breadcrumb instead, where a row of tabs with none selected would only
 * confuse.
 */
export function sectionFor(pathname: string): SectionTabsKey | null {
  const path = trimPath(pathname);
  for (const [section, tabs] of Object.entries(SECTION_TABS) as Array<[SectionTabsKey, (typeof SECTION_TABS)[SectionTabsKey]]>) {
    if (tabs.some((tab) => tab.to === path)) return section;
  }
  return null;
}

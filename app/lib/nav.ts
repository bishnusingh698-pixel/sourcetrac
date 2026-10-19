/**
 * Every place a merchant can go in the app, in one list.
 *
 * Two menus read it:
 *
 * - The in-app top bar (`TopNav`), which shows every item. It is always on
 *   screen, on desktop and on a phone, so nothing is more than one tap away.
 * - Shopify's own admin navigation (`<s-app-nav>`), which shows the items marked
 *   `sidebar`. Shopify allows at most seven there, and none may repeat the home
 *   page (the app name itself links to it), so Dashboard, Responses and Export
 *   stay out.
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
};

export const NAV = [
  { to: "/app", key: "nav.dashboard", icon: "home", sidebar: false },
  { to: "/app/surveys", key: "nav.surveys", icon: "clipboard-checklist", sidebar: true },
  // Its own item, so a merchant finds templates without knowing they sit
  // behind Surveys › New survey.
  { to: "/app/surveys/library", key: "nav.templates", icon: "collection", sidebar: true },
  { to: "/app/results", key: "nav.results", icon: "chart-vertical", sidebar: true },
  { to: "/app/dashboard", key: "nav.channels", icon: "channels", sidebar: true },
  // Off Shopify's sidebar (seven items at most) to make room for Templates;
  // still in the top bar and linked from Results.
  { to: "/app/responses", key: "nav.responses", icon: "chat", sidebar: false },
  { to: "/app/export", key: "nav.export", icon: "export", sidebar: false },
  { to: "/app/plans", key: "nav.plans", icon: "plan", sidebar: true },
  { to: "/app/settings", key: "nav.preferences", icon: "settings", sidebar: true },
  { to: "/app/help", key: "nav.help", icon: "question-circle", sidebar: true },
] as const satisfies ReadonlyArray<NavItem>;

/**
 * The `to` of the item the current page belongs to, or null (the privacy page
 * has no item of its own).
 *
 * A page belongs to the item whose path is its longest whole-segment prefix, so
 * the survey editor (`/app/surveys/...`) lights up Surveys, the template library
 * lights up Templates, and the results CSV lights up Results. `/app` itself matches only
 * exactly, or every page would light up Dashboard. `/app/surveysx` does not
 * match `/app/surveys`: the prefix has to end at a `/`.
 */
export function activeNavPath(pathname: string, items: ReadonlyArray<Pick<NavItem, "to">> = NAV): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: string | null = null;
  for (const item of items) {
    const matches =
      item.to === "/app"
        ? path === "/app"
        : path === item.to || path.startsWith(`${item.to}/`);
    if (matches && (best === null || item.to.length > best.length)) best = item.to;
  }
  return best;
}

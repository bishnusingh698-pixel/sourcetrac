/**
 * The Dashboard's date ranges. Kept out of `dashboard.server.ts` because the
 * page component needs them to draw the range buttons, and a `.server` module
 * cannot reach the browser bundle.
 */

/** The date ranges the dashboard offers, in days. 30 is the default. */
export const DASHBOARD_RANGES = [7, 30, 90] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

/** i18next keys, resolved per render (see the NAV comment in `~/lib/nav`). */
export const DASHBOARD_RANGE_LABEL_KEYS: Record<DashboardRange, string> = {
  7: "dashboard.last_7",
  30: "dashboard.last_30",
  90: "dashboard.last_90",
};

export function parseDashboardRange(value: string | null): DashboardRange {
  return DASHBOARD_RANGES.find((days) => String(days) === value) ?? 30;
}

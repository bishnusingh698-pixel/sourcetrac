/**
 * Bonus feature flags. Everything behind a `false` flag is fully hidden from
 * merchants — no nav entry, no route, no config — so the bonus phases can be
 * removed without touching the Core features.
 */
export const FEATURE_FLAGS = {
  /** B1 — on-site survey block (theme app extension). */
  ONSITE_SURVEYS: false,
  /** B2 — shareable survey link page (App Proxy). */
  SURVEY_LINK_PAGE: false,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

export function isEnabled(flag: FeatureFlag): boolean {
  return FEATURE_FLAGS[flag];
}

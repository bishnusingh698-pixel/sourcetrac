/**
 * Home's gate: whether to show the Dashboard or the first-run setup guide.
 *
 * The Dashboard's own data is built by `loadDashboard` in `dashboard.server.ts`.
 */

import { db } from "~/db.server";

/**
 * Whether this shop has ever collected an answer.
 *
 * Both tables must be checked: the single-question extension wrote
 * `SurveyResponse`, but the multi-question extension writes only `Response`.
 * Checking the legacy table alone left a merchant whose answers are all v2
 * staring at the setup guide forever.
 */
export async function hasAnyResponse(shopId: string): Promise<boolean> {
  const [legacy, v2] = await Promise.all([
    db.surveyResponse.findFirst({ where: { shopId }, select: { id: true } }),
    db.response.findFirst({ where: { shopId }, select: { id: true } }),
  ]);
  return legacy !== null || v2 !== null;
}

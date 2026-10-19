import { Prisma } from "@prisma/client";

/**
 * Order sources that never reach a Thank-you page, so the survey could never
 * have been shown. They are left out of answer rates, or a store with an
 * in-person till reads a low rate and thinks the survey is broken.
 *
 * Only `pos` is listed: Shopify staff document it as POS's `source_name`.
 * Subscription renewals have no reliable value (`subscription_contract` became
 * `subscription_contract_checkout_one` for some stores, and a first checkout
 * does see the page), so they stay counted rather than guessed at. Revenue is
 * unaffected: this only narrows who could have been asked.
 */
export const NO_THANK_YOU_SOURCES = ["pos"] as const;

/** Raw-SQL filter on an `"OrderCache"` alias: orders that could have seen the survey. */
export function couldSeeSurveySql(alias: string): Prisma.Sql {
  const column = Prisma.raw(`${alias}."sourceName"`);
  return Prisma.sql`(${column} IS NULL OR ${column} NOT IN (${Prisma.join([...NO_THANK_YOU_SOURCES])}))`;
}

/** The same filter for Prisma's query API. `notIn` alone would drop NULL rows. */
export const couldSeeSurveyWhere = {
  OR: [{ sourceName: null }, { sourceName: { notIn: [...NO_THANK_YOU_SOURCES] } }],
} satisfies Prisma.OrderCacheWhereInput;

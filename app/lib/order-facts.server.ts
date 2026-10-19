import { db } from "~/db.server";
import { logger } from "~/lib/logger";

/**
 * The first-order flag the Thank-you page reports, kept for the Order status
 * page, which has no such signal (see `OrderFact` in the schema).
 *
 * Written on the first Thank-you load that reports it, and never changed after:
 * the real page load always comes first, so a later request (a replayed
 * checkout token) cannot flip the flag. One statement; never throws.
 */
export async function recordOrderFact(shopId: string, orderId: string, isFirstOrder: boolean): Promise<void> {
  try {
    await db.orderFact.upsert({
      where: { shopId_orderId: { shopId, orderId } },
      create: { shopId, orderId, isFirstOrder },
      update: {},
    });
  } catch (error) {
    logger.warn("order_fact_write_failed", {
      shop_id: shopId,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The first-order flag the Thank-you page saw for this order, or null. Never throws. */
export async function readOrderFact(shopId: string, orderId: string): Promise<boolean | null> {
  try {
    const row = await db.orderFact.findUnique({
      where: { shopId_orderId: { shopId, orderId } },
      select: { isFirstOrder: true },
    });
    return row?.isFirstOrder ?? null;
  } catch (error) {
    logger.warn("order_fact_read_failed", {
      shop_id: shopId,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

import { db } from "~/db.server";
import { logger } from "~/lib/logger";
import type { Placement } from "@shared/survey-config";

/**
 * Whether the SourceTrac block is really in the merchant's checkout.
 *
 * Shopify exposes no "block added" state and sends no event when a checkout
 * block is placed or removed. A block that asks us for a survey, on a buyer's
 * order page or inside the checkout editor, is the only proof. The editor
 * reads this so it never tells a merchant their survey is showing in checkout
 * when the block was never added.
 */

/** The two pages a checkout block can sit on. */
export type CheckoutPlacement = Extract<Placement, "thank_you" | "order_status">;

const COLUMN = {
  thank_you: "thankYouBlockSeenAt",
  order_status: "orderStatusBlockSeenAt",
} as const satisfies Record<CheckoutPlacement, string>;

function isCheckoutPlacement(placement: Placement): placement is CheckoutPlacement {
  return placement in COLUMN;
}

/** One write per shop and page an hour is plenty: only "ever seen" is read. */
const WRITE_INTERVAL_MS = 60 * 60 * 1000;
const lastWrite = new Map<string, number>();

/**
 * Notes that a block on `placement` just asked for a survey.
 *
 * Never throws: a buyer's survey must not fail because this bookkeeping did.
 * A failure is logged and retried on the next request.
 */
export async function recordBlockSeen(shopId: string, placement: Placement, now = new Date()): Promise<void> {
  if (!isCheckoutPlacement(placement)) return;
  const key = `${shopId}:${placement}`;
  const last = lastWrite.get(key);
  if (last !== undefined && now.getTime() - last < WRITE_INTERVAL_MS) return;
  lastWrite.set(key, now.getTime());
  try {
    await db.shop.update({ where: { id: shopId }, data: { [COLUMN[placement]]: now } });
  } catch (error) {
    lastWrite.delete(key);
    logger.warn("block_seen_write_failed", {
      shop_id: shopId,
      placement,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type BlockSeen = Record<CheckoutPlacement, boolean>;

/** Which pages a SourceTrac block has been seen on since the app was installed. */
export async function getBlockSeen(shopId: string): Promise<BlockSeen> {
  const row = await db.shop.findUnique({
    where: { id: shopId },
    select: { thankYouBlockSeenAt: true, orderStatusBlockSeenAt: true },
  });
  return {
    thank_you: Boolean(row?.thankYouBlockSeenAt),
    order_status: Boolean(row?.orderStatusBlockSeenAt),
  };
}

/** Uninstalling removes the app's checkout blocks, so what we saw no longer holds. */
export async function clearBlockSeen(shopId: string): Promise<void> {
  for (const placement of Object.keys(COLUMN)) lastWrite.delete(`${shopId}:${placement}`);
  await db.shop.update({
    where: { id: shopId },
    data: { thankYouBlockSeenAt: null, orderStatusBlockSeenAt: null },
  });
}

/** Test hook: forget the in-process write throttle. */
export function resetBlockSeenThrottle(): void {
  lastWrite.clear();
}

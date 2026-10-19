import { db } from "~/db.server";
import { logger } from "~/lib/logger";
import type { Placement } from "@shared/survey-config";

/**
 * Whether the SourceTrac block is really on the merchant's Thank-you and Order
 * status pages.
 *
 * Shopify exposes no "block added" state and sends no event when a checkout
 * block is placed or removed. A block that asks us for a survey, on a buyer's
 * page or inside the checkout editor, is the only proof. The editor reads this
 * so it never tells a merchant their survey is showing when the block was never
 * added.
 */

/** The two pages a checkout block can sit on. */
export type CheckoutPlacement = Extract<Placement, "thank_you" | "order_status">;

const COLUMN = {
  thank_you: "thankYouBlockSeenAt",
  order_status: "orderStatusBlockSeenAt",
} as const satisfies Record<CheckoutPlacement, string>;

export function isCheckoutPlacement(placement: Placement): placement is CheckoutPlacement {
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

/** When the block was last seen on each page (null: never), for the Checkout check. */
export async function getBlockSeenAt(shopId: string): Promise<Record<CheckoutPlacement, Date | null>> {
  const row = await db.shop.findUnique({
    where: { id: shopId },
    select: { thankYouBlockSeenAt: true, orderStatusBlockSeenAt: true },
  });
  return { thank_you: row?.thankYouBlockSeenAt ?? null, order_status: row?.orderStatusBlockSeenAt ?? null };
}

/**
 * The merchant says the block is on these pages.
 *
 * A block that has not loaded yet (no order since it was added, or a checkout
 * editor that could not reach us) leaves the warning up although the block is
 * there, so the merchant can clear it themselves.
 */
export async function markBlockAdded(shopId: string, placements: readonly Placement[], now = new Date()): Promise<void> {
  const data: Partial<Record<(typeof COLUMN)[CheckoutPlacement], Date>> = {};
  for (const placement of placements) if (isCheckoutPlacement(placement)) data[COLUMN[placement]] = now;
  if (Object.keys(data).length === 0) return;
  await db.shop.update({ where: { id: shopId }, data });
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

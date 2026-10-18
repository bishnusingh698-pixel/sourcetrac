/**
 * The checkout block build this server expects. The block sends its own
 * `BLOCK_BUILD` (extensions/shared/src/survey-logic.ts) with every request; a
 * different or missing value means the store runs an older block, because the
 * checkout only gets new block code from `shopify app deploy`, never from a
 * server deploy. Bump both together.
 */
export const CURRENT_BLOCK_BUILD = "2026-10-18.2";

/** Whether a block that reported `build` is older than this server expects. */
export function isOutdatedBlock(build: string | null | undefined): boolean {
  return build !== CURRENT_BLOCK_BUILD;
}

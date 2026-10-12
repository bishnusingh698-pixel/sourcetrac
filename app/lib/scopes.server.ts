import { logger } from "~/lib/logger";

/**
 * Runtime scope gating.
 *
 * SourceTrac ships with `read_orders` and, from Phase 7, asks for a few write
 * scopes so it can tag orders and customers and target by collection. Every
 * merchant that installed before those scopes were added has a session whose
 * `scope` string does not contain them until they re-approve.
 *
 * So no Phase 7 feature may assume the scope is present. Each checks
 * `hasScope(session.scope, "...")` at runtime and, when it is missing, skips the
 * Shopify write and leaves the merchant's data untouched — the survey still
 * collects and reports, only the tag/metafield sync is skipped.
 */

/** Scopes Phase 7 may use, in the order they are requested. */
export const SYNC_SCOPES = ["write_orders", "write_customers", "read_products"] as const;

export type SyncScope = (typeof SYNC_SCOPES)[number];

/**
 * `session.scope` is a comma-separated string, e.g. `"read_orders,write_orders"`.
 * Absent or empty means "not granted", never "grant everything".
 */
export function hasScope(granted: string | null | undefined, scope: string): boolean {
  if (!granted) return false;
  return granted
    .split(",")
    .map((s) => s.trim())
    .includes(scope);
}

/** The sync scopes a session actually carries, for display and gating. */
export function grantedSyncScopes(granted: string | null | undefined): SyncScope[] {
  return SYNC_SCOPES.filter((scope) => hasScope(granted, scope));
}

/**
 * Gate a sync operation on a granted scope. Returns false and logs when the
 * scope is missing, so a caller can skip its Shopify write without throwing:
 * a store that has not re-approved must not see a broken app.
 */
export function canSync(granted: string | null | undefined, scope: SyncScope, shopId: string): boolean {
  if (hasScope(granted, scope)) return true;
  logger.info("sync_skipped_missing_scope", { shop_id: shopId, scope });
  return false;
}

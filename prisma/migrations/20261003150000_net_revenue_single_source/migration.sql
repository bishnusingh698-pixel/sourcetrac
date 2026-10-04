-- Net revenue has a single source: OrderCache.totalPrice holds Shopify's
-- current_total_price, which is already net of refunds, returns and edits.
-- A separate refund column invited subtracting the same refund twice.
ALTER TABLE "OrderCache" DROP COLUMN "totalRefunded";

-- NULL now means "the webhook total could not be parsed", instead of a fabricated
-- 0.00 that is indistinguishable from a genuine free order. Existing rows keep
-- their stored value.
ALTER TABLE "OrderCache" ALTER COLUMN "totalPrice" DROP NOT NULL;

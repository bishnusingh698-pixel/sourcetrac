-- Additive: the delivery time (X-Shopify-Triggered-At) of the webhook that
-- last wrote an order row. `updated_at` has one-second precision, so two
-- updates in the same second could apply out of order; this breaks the tie.
ALTER TABLE "OrderCache" ADD COLUMN "triggeredAt" TIMESTAMP(3);

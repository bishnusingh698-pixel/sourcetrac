-- Order verification for the multi-question Response model.
--
-- Additive and backward compatible: both columns are nullable / defaulted, so
-- existing rows keep working and the already-deployed single-question path is
-- untouched. Existing rows get `verified = NULL`, meaning "before verification
-- existed"; the revenue report treats a null exactly as before (the presence of
-- the order total decides), so nothing changes for historic data.
ALTER TABLE "Response" ADD COLUMN "verified" BOOLEAN;
ALTER TABLE "Response" ADD COLUMN "unverifiedFailed" BOOLEAN NOT NULL DEFAULT false;

-- Speed up the reconcile-on-arrival query (null-total rows for one order).
CREATE INDEX "Response_shopId_orderId_orderTotal_idx" ON "Response" ("shopId", "orderId", "orderTotal");

-- The charge the merchant last asked for, until Shopify makes it the live one.
-- A downgrade (or a yearly-to-monthly switch) waits for the end of the billing
-- period; this is what lets the Plans page say so instead of offering, and
-- creating, the same charge again.
ALTER TABLE "Shop" ADD COLUMN "pendingSubscriptionGid" TEXT;
ALTER TABLE "Shop" ADD COLUMN "pendingSubscriptionName" TEXT;

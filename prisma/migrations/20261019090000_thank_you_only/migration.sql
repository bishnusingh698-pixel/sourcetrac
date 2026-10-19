-- Surveys show on the Thank-you page only. The Order status block worked only
-- on stores with new customer accounts, and merchants on classic accounts had
-- no way to place it, so it was removed. Every survey now lists the one page.
UPDATE "Survey" SET "placements" = '["thank_you"]' WHERE "placements" <> '["thank_you"]';

-- The first-order flag kept for the Order status page has no reader left.
DROP TABLE "OrderFact";

ALTER TABLE "Shop" DROP COLUMN "orderStatusBlockSeenAt";

-- Where each order came from, so in-store and subscription-renewal orders,
-- which never see a Thank-you page, stop lowering the answer rate.
ALTER TABLE "OrderCache" ADD COLUMN "sourceName" TEXT;

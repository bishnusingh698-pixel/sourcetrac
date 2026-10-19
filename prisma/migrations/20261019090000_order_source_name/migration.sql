-- Where each order came from, so in-store (POS) orders, which never see a
-- Thank-you or Order status page, stop lowering the answer rate.
ALTER TABLE "OrderCache" ADD COLUMN "sourceName" TEXT;

-- Sync work is kept once done, so a retried or repeated submit finds it and
-- does not run the merchant's Flow or tags again; and a drainer's lease is its
-- own column, so resetting the backoff for an arrived order cannot break it.
ALTER TABLE "PendingSync" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "PendingSync" ADD COLUMN "leaseUntil" TIMESTAMP(3);

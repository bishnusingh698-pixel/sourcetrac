-- Additive.
-- Shop.installedAt: when the current installation began, so a late
-- app/uninstalled or shop/redact from an earlier installation is not applied to
-- a shop that has since reinstalled. Existing installed shops are seeded with
-- their creation time (a lower bound for the current installation).
ALTER TABLE "Shop" ADD COLUMN "installedAt" TIMESTAMP(3);
UPDATE "Shop" SET "installedAt" = "createdAt" WHERE "installState" = 'installed';

-- Orders named by customers/redact. Never cached or answered again.
CREATE TABLE "RedactedOrder" (
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedactedOrder_pkey" PRIMARY KEY ("shopId","orderId")
);
CREATE INDEX "RedactedOrder_createdAt_idx" ON "RedactedOrder"("createdAt");
ALTER TABLE "RedactedOrder" ADD CONSTRAINT "RedactedOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Recent checkouts: what the Thank-you block was told on each page load, kept
-- in the database so a restart or deploy no longer wipes it.
CREATE TABLE "CheckoutLoad" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    "surveyId" TEXT,
    "reason" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "country" TEXT,
    "isFirstOrder" BOOLEAN,

    CONSTRAINT "CheckoutLoad_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CheckoutLoad_shopId_at_idx" ON "CheckoutLoad"("shopId", "at");

ALTER TABLE "CheckoutLoad" ADD CONSTRAINT "CheckoutLoad_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

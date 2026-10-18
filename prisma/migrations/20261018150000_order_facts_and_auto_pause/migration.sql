-- AlterTable
ALTER TABLE "Survey" ADD COLUMN "autoPausedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrderFact" (
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "isFirstOrder" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderFact_pkey" PRIMARY KEY ("shopId","orderId")
);

-- CreateIndex
CREATE INDEX "OrderFact_createdAt_idx" ON "OrderFact"("createdAt");

-- AddForeignKey
ALTER TABLE "OrderFact" ADD CONSTRAINT "OrderFact_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

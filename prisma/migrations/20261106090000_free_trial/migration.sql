-- 14-day free trial on Growth and Scale. Additive only: one nullable column on
-- "Shop" and one new table. Existing shops read trialEndsAt = NULL (no trial
-- running), which is their state today.

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "trialEndsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TrialLedger" (
    "id" TEXT NOT NULL,
    "domainKey" TEXT NOT NULL,
    "shopKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "plan" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrialLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrialLedger_domainKey_key" ON "TrialLedger"("domainKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrialLedger_shopKey_key" ON "TrialLedger"("shopKey");

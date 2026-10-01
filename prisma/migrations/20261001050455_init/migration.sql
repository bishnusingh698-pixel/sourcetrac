-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('free', 'growth', 'scale');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('active', 'cancelled', 'declined', 'frozen', 'expired');

-- CreateEnum
CREATE TYPE "InstallState" AS ENUM ('installed', 'uninstalled');

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT,
    "accessTokenIv" TEXT,
    "accessTokenTag" TEXT,
    "installState" "InstallState" NOT NULL DEFAULT 'installed',
    "uninstalledAt" TIMESTAMP(3),
    "plan" "Plan" NOT NULL DEFAULT 'free',
    "planStatus" "PlanStatus" NOT NULL DEFAULT 'active',
    "subscriptionGid" TEXT,
    "planDisplayName" TEXT,
    "checkoutSupported" BOOLEAN,
    "checkoutCheckedAt" TIMESTAMP(3),
    "questionText" TEXT NOT NULL DEFAULT 'How did you hear about us?',
    "optionsJson" TEXT NOT NULL,
    "allowOther" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyResponse" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "otherText" TEXT,
    "currency" TEXT,
    "orderTotal" DECIMAL(12,2),
    "locale" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "unreconcilable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCache" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "currency" TEXT NOT NULL,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "totalRefunded" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "financialStatus" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "createdAtShop" TIMESTAMP(3) NOT NULL,
    "updatedAtShop" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "apiVersion" TEXT,
    "triggerRef" TEXT,
    "payloadJson" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingUsage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "responsesCount" INTEGER NOT NULL DEFAULT 0,
    "cap" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopId_key" ON "Shop"("shopId");

-- CreateIndex
CREATE INDEX "Shop_installState_idx" ON "Shop"("installState");

-- CreateIndex
CREATE INDEX "SurveyResponse_shopId_submittedAt_idx" ON "SurveyResponse"("shopId", "submittedAt");

-- CreateIndex
CREATE INDEX "SurveyResponse_shopId_channel_idx" ON "SurveyResponse"("shopId", "channel");

-- CreateIndex
CREATE INDEX "SurveyResponse_shopId_isLocked_idx" ON "SurveyResponse"("shopId", "isLocked");

-- CreateIndex
CREATE INDEX "SurveyResponse_shopId_reconciled_idx" ON "SurveyResponse"("shopId", "reconciled");

-- CreateIndex
CREATE INDEX "SurveyResponse_shopId_orderId_idx" ON "SurveyResponse"("shopId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SurveyResponse_shopId_orderId_key" ON "SurveyResponse"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "OrderCache_shopId_updatedAtShop_idx" ON "OrderCache"("shopId", "updatedAtShop");

-- CreateIndex
CREATE INDEX "OrderCache_shopId_isTest_isCancelled_idx" ON "OrderCache"("shopId", "isTest", "isCancelled");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCache_shopId_orderId_key" ON "OrderCache"("shopId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopId_createdAt_idx" ON "WebhookEvent"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- CreateIndex
CREATE INDEX "BillingUsage_shopId_periodStart_idx" ON "BillingUsage"("shopId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "BillingUsage_shopId_periodStart_key" ON "BillingUsage"("shopId", "periodStart");

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCache" ADD CONSTRAINT "OrderCache_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingUsage" ADD CONSTRAINT "BillingUsage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

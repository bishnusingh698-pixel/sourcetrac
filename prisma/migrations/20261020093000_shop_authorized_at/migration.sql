-- When Shopify last granted this app a token for the shop (proof it was
-- installed then), and when the latest app/uninstalled says the app was
-- removed. Together they tell a late uninstall or shop/redact delivery for a
-- previous installation from one for the current installation.
ALTER TABLE "Shop" ADD COLUMN "authorizedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "uninstallTriggeredAt" TIMESTAMP(3);

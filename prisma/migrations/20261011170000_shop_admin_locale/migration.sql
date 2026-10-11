-- Remember the Shopify admin locale from the first document load; in-app
-- navigations do not carry `?locale=`, so the admin language used to flip.
ALTER TABLE "Shop" ADD COLUMN "adminLocale" TEXT;

-- Store the merchant's chosen admin UI language.
--
-- Nullable on purpose: null means "never chose one", which tells the app to
-- fall back to detecting the Shopify admin locale. Backfilling every existing
-- shop with a detected value here would freeze the detected language forever
-- and defeat the selector.
--
-- A plain TEXT column rather than a Postgres enum, so adding a language later
-- does not require an ALTER TYPE on a table the app is always writing to.
ALTER TABLE "Shop" ADD COLUMN "language" TEXT;

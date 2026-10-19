-- The offline token now lives only in the session storage, which refreshes it.
-- The copy kept on each shop row is either expired or a legacy non-expiring
-- token Shopify refuses ("Non-expiring access tokens are no longer accepted"),
-- and nothing reads it any more, so it is erased rather than kept at rest.
UPDATE "Shop"
SET "accessTokenEncrypted" = NULL, "accessTokenIv" = NULL, "accessTokenTag" = NULL
WHERE "accessTokenEncrypted" IS NOT NULL OR "accessTokenIv" IS NOT NULL OR "accessTokenTag" IS NOT NULL;

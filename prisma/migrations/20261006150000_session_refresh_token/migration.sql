-- Required by @shopify/shopify-app-session-storage-prisma v11, which writes both
-- columns on every storeSession call. Nullable, so existing rows are unaffected.
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "refreshToken" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "refreshTokenExpires" TIMESTAMP(3);

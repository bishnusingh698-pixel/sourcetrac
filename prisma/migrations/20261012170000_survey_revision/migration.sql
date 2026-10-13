-- Optimistic-concurrency token for the Survey Studio (section 6.6).
--
-- Additive and backward compatible: existing rows default to 0. Not a Prisma
-- `@updatedAt` column on purpose: `responseCount` is incremented on every answer,
-- so `updatedAt` would move for reasons the editor never caused and raise false
-- conflicts. `revision` only moves on merchant edits.
ALTER TABLE "Survey"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- Templates, Insight Library and Survey Studio (Phase 1 data model).
--
-- Entirely additive and backward compatible: every new column is nullable or has
-- a default, so nothing that works today breaks and no existing row is rewritten.

-- Survey: template provenance, rotation, learn & stop, design and drafts.
ALTER TABLE "Survey"
  ADD COLUMN "templateId" TEXT,
  ADD COLUMN "templateVersion" INTEGER,
  ADD COLUMN "rotation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rotationWeight" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "learnAndStop" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "designJson" TEXT NOT NULL DEFAULT '{}',
  ADD COLUMN "draft" TEXT,
  ADD COLUMN "draftUpdatedAt" TIMESTAMP(3);

-- Option: the T6 exclusive flag.
ALTER TABLE "Option"
  ADD COLUMN "exclusive" BOOLEAN NOT NULL DEFAULT false;

-- Response: product ids for T8 (results by product).
ALTER TABLE "Response"
  ADD COLUMN "productIds" TEXT DEFAULT '[]';

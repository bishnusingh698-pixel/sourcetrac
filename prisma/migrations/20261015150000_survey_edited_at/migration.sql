-- When the merchant last changed a survey. `updatedAt` also moves on every
-- buyer answer, so the survey list's "Updated" date read as today on any busy
-- survey. Existing rows start from `updatedAt`, the best value available.
ALTER TABLE "Survey" ADD COLUMN "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "Survey" SET "editedAt" = "updatedAt";

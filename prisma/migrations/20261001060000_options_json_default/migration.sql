-- Default the survey options column so a shop row is valid on creation.
ALTER TABLE "Shop" ALTER COLUMN "optionsJson" SET DEFAULT '[]';
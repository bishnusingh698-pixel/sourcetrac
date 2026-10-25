-- F4: an answer can be limited to buyers in some countries.
-- Additive: existing rows get '[]', which means every country, today's behaviour.
ALTER TABLE "Option" ADD COLUMN "countries" TEXT NOT NULL DEFAULT '[]';

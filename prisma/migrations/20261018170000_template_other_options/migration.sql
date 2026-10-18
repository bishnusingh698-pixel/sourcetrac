-- Surveys created from a template stored their "Other (please specify)" choice
-- as a plain option, so a buyer who picked it got no box to type in. Template
-- option rows remember their stable id in "templateKey", which ends in the
-- option key: "other" (every template and channel pack) or "other_pet".
UPDATE "Option"
SET "isOther" = true
WHERE "isOther" = false
  AND "templateKey" IS NOT NULL
  AND ("templateKey" LIKE '%\_other' ESCAPE '\' OR "templateKey" LIKE '%\_other\_pet' ESCAPE '\');

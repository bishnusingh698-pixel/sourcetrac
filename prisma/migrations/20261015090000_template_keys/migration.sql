-- Additive: the template key a question/option was created from.
--
-- Template surveys used to post their stable ids (e.g. `did_you_compare_q1`)
-- as row ids. Those are global primary keys, so they could not be stored as-is
-- (a second survey from the same template would collide) and were replaced by
-- fresh ids, which broke every show-if, smart action and cross-question view
-- that names the stable id. Rows now get unique ids and remember the stable key
-- here; readers translate through it.
ALTER TABLE "Question" ADD COLUMN "templateKey" TEXT;
ALTER TABLE "Option" ADD COLUMN "templateKey" TEXT;

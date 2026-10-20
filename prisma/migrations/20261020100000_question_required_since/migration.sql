-- The published survey version from which a question is required. A buyer who
-- loaded an older version is excused only from questions required since then,
-- never from every required question.
ALTER TABLE "Question" ADD COLUMN "requiredSinceVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('draft', 'active', 'paused');

-- CreateEnum
CREATE TYPE "SurveyLayout" AS ENUM ('all', 'one_by_one');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('single_choice', 'multi_choice', 'dropdown', 'yes_no', 'rating_5', 'satisfaction_5', 'nps', 'text');

-- CreateEnum
CREATE TYPE "PendingSyncKind" AS ENUM ('metafield', 'tags', 'customer', 'flow');

-- CreateEnum
CREATE TYPE "PendingDeletionScope" AS ENUM ('shop', 'customer');

-- CreateEnum
CREATE TYPE "SurveyPlacement" AS ENUM ('thank_you', 'order_status', 'onsite', 'link');

-- CreateTable
CREATE TABLE "Survey" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SurveyStatus" NOT NULL DEFAULT 'draft',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "placements" TEXT NOT NULL DEFAULT '[]',
    "layout" "SurveyLayout" NOT NULL DEFAULT 'all',
    "title" TEXT,
    "intro" TEXT,
    "buttonLabel" TEXT,
    "thankYouText" TEXT,
    "translations" TEXT NOT NULL DEFAULT '{}',
    "targeting" TEXT NOT NULL DEFAULT '{}',
    "channelReportQuestionId" TEXT,
    "syncOptions" TEXT NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "responseCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "QuestionType" NOT NULL,
    "text" TEXT NOT NULL,
    "helpText" TEXT,
    "placeholder" TEXT,
    "textMultiline" BOOLEAN NOT NULL DEFAULT false,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "randomizeOptions" BOOLEAN NOT NULL DEFAULT false,
    "allowOther" BOOLEAN NOT NULL DEFAULT false,
    "minSelections" INTEGER,
    "maxSelections" INTEGER,
    "showIf" TEXT,
    "tagPrefix" TEXT,
    "translations" TEXT NOT NULL DEFAULT '{}',
    "archived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Option" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "isOther" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "translations" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "Option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Response" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "surveyVersion" INTEGER NOT NULL,
    "orderId" TEXT,
    "customerId" TEXT,
    "orderTotal" DECIMAL(18,3),
    "currency" TEXT,
    "isFirstOrder" BOOLEAN,
    "placement" "SurveyPlacement" NOT NULL,
    "locale" TEXT,
    "country" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Response_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "optionIds" TEXT NOT NULL DEFAULT '[]',
    "numberValue" INTEGER,
    "textValue" TEXT,
    "otherText" TEXT,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyDailyStats" (
    "shopId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "SurveyDailyStats_pkey" PRIMARY KEY ("surveyId","questionId","day","bucket","currency")
);

-- CreateTable
CREATE TABLE "PendingSync" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "kind" "PendingSyncKind" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingDeletion" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "scope" "PendingDeletionScope" NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataRequest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Survey_shopId_status_priority_idx" ON "Survey"("shopId", "status", "priority");

-- CreateIndex
CREATE INDEX "Question_surveyId_position_idx" ON "Question"("surveyId", "position");

-- CreateIndex
CREATE INDEX "Option_questionId_position_idx" ON "Option"("questionId", "position");

-- CreateIndex
CREATE INDEX "Response_shopId_createdAt_idx" ON "Response"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Response_shopId_surveyId_createdAt_idx" ON "Response"("shopId", "surveyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Response_shopId_surveyId_orderId_key" ON "Response"("shopId", "surveyId", "orderId");

-- CreateIndex
CREATE INDEX "Answer_responseId_idx" ON "Answer"("responseId");

-- CreateIndex
CREATE INDEX "Answer_questionId_idx" ON "Answer"("questionId");

-- CreateIndex
CREATE INDEX "SurveyDailyStats_shopId_surveyId_day_idx" ON "SurveyDailyStats"("shopId", "surveyId", "day");

-- CreateIndex
CREATE INDEX "PendingSync_shopId_nextAttemptAt_idx" ON "PendingSync"("shopId", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PendingDeletion_shopId_createdAt_idx" ON "PendingDeletion"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "DataRequest_shopId_createdAt_idx" ON "DataRequest"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Option" ADD CONSTRAINT "Option_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Response" ADD CONSTRAINT "Response_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Response" ADD CONSTRAINT "Response_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "Response"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyDailyStats" ADD CONSTRAINT "SurveyDailyStats_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyDailyStats" ADD CONSTRAINT "SurveyDailyStats_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingSync" ADD CONSTRAINT "PendingSync_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingDeletion" ADD CONSTRAINT "PendingDeletion_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataRequest" ADD CONSTRAINT "DataRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Lossless backfill (Phase 2.2).
--
-- Converts the existing single-question survey (Shop.questionText + optionsJson)
-- and every existing SurveyResponse into the new Survey / Question / Option /
-- Response / Answer / SurveyDailyStats model. No existing column is dropped, and
-- option ids are preserved verbatim, so a later read through either model agrees.
--
-- Written as one PL/pgSQL DO block so it can parse the JSON options in a loop.
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE
  s RECORD;
  opt JSONB;
  pos INTEGER;
  survey_id TEXT;
  question_id TEXT;
  option_value TEXT;
  option_label TEXT;
  resp RECORD;
  new_response_id TEXT;
  v_inc BOOLEAN;
  day_key TEXT;
  rev DECIMAL(18,3);
  cur TEXT;
  allow_other BOOLEAN;
BEGIN
  FOR s IN SELECT * FROM "Shop" LOOP
    survey_id := 'bf-survey-' || s.id;
    question_id := 'bf-question-' || s.id;
    allow_other := COALESCE(s."allowOther", false);

    INSERT INTO "Survey" (
      "id", "shopId", "name", "status", "priority", "placements", "layout",
      "title", "thankYouText", "channelReportQuestionId", "version",
      "responseCount", "createdAt", "updatedAt"
    ) VALUES (
      survey_id, s.id, 'How did you hear about us?', 'active', 0, '["thank_you","order_status"]', 'all',
      'Quick question', 'Thanks for your feedback!', question_id, 1,
      0, now(), now()
    );

    INSERT INTO "Question" (
      "id", "surveyId", "position", "type", "text", "required", "allowOther"
    ) VALUES (
      question_id, survey_id, 0, 'single_choice', COALESCE(s."questionText", 'How did you hear about us?'),
      false, allow_other
    );

    pos := 0;
    FOR opt IN SELECT value FROM jsonb_array_elements(COALESCE(NULLIF(s."optionsJson", '')::jsonb, '[]'::jsonb)) LOOP
      option_value := opt->>'value';
      option_label := COALESCE(opt->>'label', option_value);
      IF option_value IS NOT NULL AND option_value <> '' THEN
        INSERT INTO "Option" ("id", "questionId", "position", "label", "isOther", "archived")
        VALUES (option_value, question_id, pos, option_label, (option_value = 'other'), false);
        pos := pos + 1;
      END IF;
    END LOOP;

    -- Responses for this shop, in time order.
    FOR resp IN
      SELECT * FROM "SurveyResponse" WHERE "shopId" = s.id ORDER BY "submittedAt" ASC
    LOOP
      new_response_id := 'bf-response-' || resp.id;

      INSERT INTO "Response" (
        "id", "shopId", "surveyId", "surveyVersion", "orderId", "orderTotal", "currency",
        "placement", "locale", "createdAt"
      ) VALUES (
        new_response_id, s.id, survey_id, 1, resp."orderId", resp."orderTotal", resp."currency",
        'thank_you', resp."locale", resp."submittedAt"
      );

      INSERT INTO "Answer" ("id", "shopId", "responseId", "questionId", "optionIds", "otherText")
      VALUES (
        'bf-answer-' || resp.id, s.id, new_response_id, question_id,
        jsonb_build_array(resp.channel)::text, resp."otherText"
      );

      -- Revenue decision for the totals table, matching evaluateResponseRevenue:
      -- only a reconciled, non-unreconcilable answer on a cached, countable order
      -- contributes; everything else counts responses only.
      v_inc := false;
      rev := 0;
      cur := COALESCE(resp.currency, '');

      IF resp.reconciled AND NOT resp.unreconcilable THEN
        SELECT (NOT o."isTest" AND NOT o."isCancelled"
                AND COALESCE(o."financialStatus", '') NOT IN ('voided', 'expired', 'refunded')
                AND o."totalPrice" IS NOT NULL
                AND o."totalPrice" >= 0
                AND NOT (COALESCE(o."financialStatus", '') = 'partially_refunded' AND o."totalPrice" = 0))
          INTO v_inc
        FROM "OrderCache" o
        WHERE o."shopId" = s.id AND o."orderId" = resp."orderId";

        IF v_inc IS TRUE THEN
          rev := COALESCE(resp."orderTotal", 0);
        ELSE
          v_inc := false;
          rev := 0;
        END IF;
      END IF;

      day_key := to_char(resp."submittedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD');

      INSERT INTO "SurveyDailyStats" ("shopId", "surveyId", "questionId", "day", "bucket", "count", "revenue", "currency")
      VALUES (s.id, survey_id, question_id, day_key, resp.channel, 1, rev, cur)
      ON CONFLICT ("surveyId", "questionId", "day", "bucket", "currency")
      DO UPDATE SET "count" = "SurveyDailyStats"."count" + 1,
                    "revenue" = "SurveyDailyStats"."revenue" + EXCLUDED."revenue";

      INSERT INTO "SurveyDailyStats" ("shopId", "surveyId", "questionId", "day", "bucket", "count", "revenue", "currency")
      VALUES (s.id, survey_id, question_id, day_key, '_responses', 1, rev, cur)
      ON CONFLICT ("surveyId", "questionId", "day", "bucket", "currency")
      DO UPDATE SET "count" = "SurveyDailyStats"."count" + 1,
                    "revenue" = "SurveyDailyStats"."revenue" + EXCLUDED."revenue";
    END LOOP;

    UPDATE "Survey" SET "responseCount" = (
      SELECT COUNT(*) FROM "SurveyResponse" WHERE "shopId" = s.id
    ) WHERE "id" = survey_id;
  END LOOP;
END
$backfill$;


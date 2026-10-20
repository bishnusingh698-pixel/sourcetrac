-- The hourly "order never arrived" sweep runs across every shop; without these
-- it scanned both answer tables in full each time.
CREATE INDEX "SurveyResponse_reconciled_unreconcilable_submittedAt_idx" ON "SurveyResponse"("reconciled", "unreconcilable", "submittedAt");
CREATE INDEX "Response_orderTotal_unverifiedFailed_createdAt_idx" ON "Response"("orderTotal", "unverifiedFailed", "createdAt");

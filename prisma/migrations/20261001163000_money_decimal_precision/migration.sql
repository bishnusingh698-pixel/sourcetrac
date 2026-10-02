-- Widen money columns from 2 to 3 fractional places.
-- KWD, BHD, IQD, JOD, LYD, OMR and TND are three-decimal currencies; Decimal(12,2)
-- rounded 1.234 KWD to 1.23 on insert. Widening the type preserves every stored
-- value, so no data conversion is required.
ALTER TABLE "SurveyResponse" ALTER COLUMN "orderTotal" TYPE DECIMAL(12,3);
ALTER TABLE "OrderCache" ALTER COLUMN "totalPrice" TYPE DECIMAL(12,3);
ALTER TABLE "OrderCache" ALTER COLUMN "totalRefunded" TYPE DECIMAL(12,3);

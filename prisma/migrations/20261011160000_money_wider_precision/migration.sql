-- Widen money columns from 9 to 15 integer digits.
-- Decimal(12,3) overflowed at 1,000,000,000: an ordinary VND, IDR or LAK order
-- of that size raised numeric overflow (22003) on every webhook retry, so the
-- order was never cached and its answer was written off. Widening preserves every
-- stored value, so no data conversion is required.
ALTER TABLE "SurveyResponse" ALTER COLUMN "orderTotal" TYPE DECIMAL(18,3);
ALTER TABLE "OrderCache" ALTER COLUMN "totalPrice" TYPE DECIMAL(18,3);

/**
 * Currency-safe money handling.
 *
 * Absolute rule (docs/03 FLOW 14): revenue is NEVER summed across currencies.
 * There is no conversion, because a conversion needs a rate source, a rate
 * timestamp, and an accuracy claim we cannot make. Separation is honest.
 *
 * All arithmetic goes through integer minor units. Shopify prices are decimal
 * strings; floats would introduce rounding drift that shows up as pennies that
 * don't reconcile against Shopify's own reports.
 */

export type CurrencyCode = string;

/**
 * Currencies whose minor unit is not 1/100.
 *
 * The three-decimal set matters for correctness, not tidiness: a Kuwaiti dinar
 * order total of "1.234" has three fractional digits, and treating it as
 * two-decimal rejects the value as over-precise. That would drop a real order's
 * revenue rather than mis-round it.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function minorUnitDigits(currency: CurrencyCode): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

export type ParseResult =
  | { ok: true; minor: number; decimals: number }
  | { ok: false; reason: string };

/**
 * Parse a Shopify decimal string into integer minor units.
 *
 * Rejects rather than rounds when the value has more precision than the
 * currency allows, so a malformed payload surfaces instead of quietly
 * losing a fraction of a cent. The one exception is up to two fractional
 * digits on a zero-decimal currency, which is rounded to the whole unit.
 */
export function parseMoneyToMinor(value: string | number | null | undefined, currency: CurrencyCode): ParseResult {
  if (value === null || value === undefined || value === "") {
    return { ok: false, reason: "empty" };
  }

  const raw = typeof value === "number" ? String(value) : value.trim();
  // At least one digit is required. `\d*` alone accepts "", "   " and "-", all of
  // which fall through to a clean 0 and read as a real zero-value order rather
  // than as a payload we could not understand.
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    return { ok: false, reason: `not_a_decimal:${raw.slice(0, 20)}` };
  }

  const decimals = minorUnitDigits(currency);
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  // The money columns are Decimal(18,3): 15 integer digits. A larger value
  // would raise numeric overflow on insert and fail its webhook on every retry,
  // so it is rejected here and stored as an unparseable (NULL) total instead.
  if (whole.replace(/^0+/, "").length > 15) {
    return { ok: false, reason: "out_of_range" };
  }

  // Trailing zeros are not extra precision. Postgres renders a numeric at its
  // declared column scale, so a USD total stored in a `Decimal(12,3)` column
  // comes back as "42.500" — rejecting that would drop every two-decimal order's
  // revenue from the dashboard. Only genuinely significant digits past the
  // currency's precision are an error.
  let significant = fraction.replace(/0+$/, "");
  let wholeDigits = whole;
  if (significant.length > decimals && decimals === 0 && significant.length <= 2) {
    // A currency listed here as zero-decimal (ISO 4217) can still arrive with
    // cents, e.g. ISK "1990.50". Rejecting it left that order's revenue Pending
    // forever; rounding to the whole unit (half up) is off by under one unit.
    if (Number.parseInt(significant.padEnd(2, "0"), 10) >= 50) {
      wholeDigits = (BigInt(whole || "0") + 1n).toString();
    }
    significant = "";
  }
  if (significant.length > decimals) {
    return { ok: false, reason: `too_many_decimals:${significant.length}>${decimals}` };
  }

  // Pad from the trimmed fraction. Padding the untrimmed one would inflate the
  // value: "42.500" would become 42.5 * 1000 minor units instead of * 100.
  const padded = significant.padEnd(decimals, "0");
  const minor = Number.parseInt(`${wholeDigits}${padded}` || "0", 10);
  if (!Number.isSafeInteger(minor)) {
    return { ok: false, reason: "out_of_safe_range" };
  }

  return { ok: true, minor: negative ? -minor : minor, decimals };
}

/** Render minor units back to a plain decimal string, e.g. 1234 -> "12.34". */
export function minorToDecimalString(minor: number, currency: CurrencyCode): string {
  const decimals = minorUnitDigits(currency);
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const asString = String(abs).padStart(decimals + 1, "0");
  const whole = asString.slice(0, asString.length - decimals) || "0";
  const fraction = decimals > 0 ? asString.slice(asString.length - decimals) : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export type Sum = { currency: CurrencyCode; minor: number };

/**
 * Average order value in minor units for a single currency.
 * Returns null for zero or negative counts so callers render an em dash rather
 * than dividing by zero (docs/03 FLOW 14).
 */
export function averageOrderValue(totalMinor: number, orderCount: number): number | null {
  if (!Number.isFinite(orderCount) || orderCount <= 0) return null;
  const result = totalMinor / orderCount;
  return Number.isFinite(result) ? result : null;
}

/**
 * Format minor units for merchant display. Uses Intl with the currency, which
 * is available in Node 22 with full ICU.
 */
export function formatMoney(minor: number | null, currency: CurrencyCode, locale = "en-US"): string {
  if (minor === null || !Number.isFinite(minor)) return "—";
  const decimals = minorUnitDigits(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(minor / 10 ** decimals);
  } catch {
    // Unknown currency code — fall back to a plain, unambiguous rendering
    // rather than showing "NaN" or throwing.
    return `${minorToDecimalString(minor, currency)} ${currency.toUpperCase()}`;
  }
}

/** Anything with a numeric string form: Prisma Decimal, string, or number. */
type DecimalLike = { toString(): string } | string | number | null | undefined;

/**
 * Render a stored major-unit value at its currency's true precision.
 *
 * `orderTotal` and `OrderCache.totalPrice` arrive from Prisma as Decimal, so the
 * export path must not re-round them to a fixed two places: a Kuwaiti dinar order
 * of 1.234 would export as 1.23 and a JPY order of 5000 as 5000.00. Both are wrong
 * in a file the merchant is going to reconcile against Shopify.
 */
export function formatDecimalForCurrency(value: DecimalLike, currency: CurrencyCode): string | null {
  if (value === null || value === undefined) return null;

  const raw = value.toString();
  if (raw === "") return null;

  // Exactly, through integer minor units: a float loses digits on large totals
  // (fifteen integer digits are allowed) and rounds some halves the wrong way.
  const parsed = parseMoneyToMinor(raw, currency);
  if (parsed.ok) return minorToDecimalString(parsed.minor, currency);

  // A value with more precision than the currency has (never written by the
  // app, but readable from older rows) is rounded for display, as before.
  const decimals = minorUnitDigits(currency);
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return numeric.toFixed(decimals);
}

/** Percentage change between two periods. Null when the baseline is zero. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  return Number.isFinite(change) ? change : null;
}

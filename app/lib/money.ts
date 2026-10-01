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
 * losing a fraction of a cent.
 */
export function parseMoneyToMinor(value: string | number | null | undefined, currency: CurrencyCode): ParseResult {
  if (value === null || value === undefined || value === "") {
    return { ok: false, reason: "empty" };
  }

  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!/^-?\d*(\.\d+)?$/.test(raw)) {
    return { ok: false, reason: `not_a_decimal:${raw.slice(0, 20)}` };
  }

  const decimals = minorUnitDigits(currency);
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  if (fraction.length > decimals) {
    return { ok: false, reason: `too_many_decimals:${fraction.length}>${decimals}` };
  }

  const padded = fraction.padEnd(decimals, "0");
  const minor = Number.parseInt(`${whole}${padded}` || "0", 10);
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
 * Sum a set of amounts, grouped by currency. This function deliberately has no
 * way to return a single total: grouping is the only correct output shape.
 */
export function sumByCurrency(
  amounts: ReadonlyArray<{ amount: string | number; currency: CurrencyCode }>,
): Sum[] {
  const totals = new Map<CurrencyCode, number>();

  for (const { amount, currency } of amounts) {
    const parsed = parseMoneyToMinor(amount, currency);
    if (!parsed.ok) continue; // unparseable rows are excluded, not summed as zero
    const current = totals.get(currency) ?? 0;
    const next = current + parsed.minor;
    if (!Number.isSafeInteger(next)) continue;
    totals.set(currency, next);
  }

  return [...totals.entries()]
    .map(([currency, minor]) => ({ currency, minor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

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

/** Percentage change between two periods. Null when the baseline is zero. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  return Number.isFinite(change) ? change : null;
}

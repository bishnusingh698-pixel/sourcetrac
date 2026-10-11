/**
 * CSV export.
 *
 * Built for a merchant opening the file in Excel, Numbers or Google Sheets, so
 * every column is something a person can read without reformatting:
 *
 *   - `order` is the order name the merchant knows from the Shopify admin
 *     ("#1001"). The internal numeric id (6123456789012) is 13 digits, which
 *     spreadsheets display as `6.12346E+12` and which nobody can search for in
 *     the admin. It is still carried, inside `order_link`, as text.
 *   - `submitted_at` is in the shop's own time zone as `YYYY-MM-DD HH:mm:ss`,
 *     which every spreadsheet recognises as a date-time. The raw ISO-8601 UTC
 *     form (`2026-10-11T08:42:07.311Z`) read as the wrong time to anyone not in
 *     UTC. The zone used is written in `timezone`, so the value is never
 *     ambiguous.
 *   - `order_total` / `currency` are the order's net total whenever the order is
 *     known, test orders included, and `revenue_status` says whether the
 *     dashboard counts it. A blank total means the order has not arrived.
 *
 * No customer name, email, phone or address exists to leak, which is the
 * easiest way to keep this export App Store safe.
 *
 * Every field goes through `escapeCsvValue`. A value beginning with = + - @
 * is prefixed with a single quote so a spreadsheet treats it as text instead
 * of a formula — channel labels are merchant-authored, free-text answers are
 * buyer-authored, and a cell containing "=cmd()" must never execute when the
 * merchant opens the file.
 */

export type RevenueStatus =
  | "counted"
  | "awaiting order"
  | "order not received"
  | "test order"
  | "cancelled"
  | "voided"
  | "refunded"
  | "total unreadable";

export type CsvRow = {
  /** Shopify order name, e.g. "#1001". Null until the order webhook lands. */
  orderName: string | null;
  /** Numeric order id, as stored. Used for `order_link`. */
  orderId: string;
  /** Already formatted in `timeZone`, see `formatTimestamp`. */
  submittedAt: string;
  timeZone: string;
  /** The merchant's label for the channel, not its internal key. */
  channel: string;
  /** The buyer's free-text answer when they picked "Other". */
  otherAnswer: string | null;
  /** Net order total at the currency's precision. Null = order not received. */
  orderTotal: string | null;
  currency: string | null;
  revenueStatus: RevenueStatus;
  orderLink: string;
};

export const CSV_HEADERS = [
  "order",
  "submitted_at",
  "timezone",
  "channel",
  "other_answer",
  "order_total",
  "currency",
  "revenue_status",
  "order_link",
] as const;

/**
 * Written in front of the header. Without it Excel on Windows reads the file as
 * the system code page, so every non-ASCII label ("Mundpropaganda", "友人の紹介",
 * an emoji) opens as mojibake. Sheets, Numbers and LibreOffice all skip it.
 */
export const UTF8_BOM = "﻿";

/**
 * Neutralise formula injection, then quote per RFC 4180.
 *
 * Leading whitespace defeats a naive startsWith check, so we look past it
 * before deciding to prefix.
 */
export function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";

  const raw = String(value);

  const leadingWhitespace = raw.length - raw.trimStart().length;
  const meaningful = raw.trimStart();

  const needsQuoteGuard =
    meaningful.length > 0 && (meaningful.startsWith("=") || meaningful.startsWith("+") || meaningful.startsWith("-") || meaningful.startsWith("@"));

  const guarded = needsQuoteGuard ? `${raw.slice(0, leadingWhitespace)}'${raw.slice(leadingWhitespace)}` : raw;

  if (!/[",\r\n]/.test(guarded)) {
    return guarded;
  }

  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(rows: ReadonlyArray<CsvRow>): string {
  const lines: string[] = [CSV_HEADERS.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.orderName,
        row.submittedAt,
        row.timeZone,
        row.channel,
        row.otherAnswer,
        row.orderTotal,
        row.currency,
        row.revenueStatus,
        row.orderLink,
      ]
        .map(escapeCsvValue)
        .join(","),
    );
  }

  // Trailing newline: some spreadsheet importers drop the final row without it.
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

/** True when `Intl` knows the zone. Shopify's `ianaTimezone` always should. */
export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The zone the export will actually use: the shop's, or UTC if unusable. */
export function resolveExportTimeZone(timeZone: string | null | undefined): string {
  return isValidTimeZone(timeZone) ? timeZone : "UTC";
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // h23, not hour12: false. The latter renders midnight as "24" in some
    // ICU versions, which no spreadsheet parses.
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/**
 * `2026-10-11 14:12:07` in `timeZone`.
 *
 * Built from `formatToParts` rather than a locale string, so the layout is fixed
 * whatever ICU data the server ships, and a spreadsheet parses it as a
 * date-time in every locale.
 */
export function formatTimestamp(date: Date, timeZone: string): string {
  const p = zonedParts(date, resolveExportTimeZone(timeZone));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** `https://admin.shopify.com/store/<handle>/orders/<id>`. */
export function orderAdminLink(shopDomain: string, orderId: string): string {
  const handle = shopDomain.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${encodeURIComponent(handle)}/orders/${encodeURIComponent(orderId)}`;
}

/** Dated in the shop's zone, so a download just after local midnight is "today". */
export function csvFilename(now = new Date(), timeZone = "UTC"): string {
  const stamp = formatTimestamp(now, timeZone).slice(0, 10);
  return `sourcetrac-responses-${stamp}.csv`;
}

/**
 * CSV export.
 *
 * Columns are exactly what the merchant asked for: order ID, timestamp,
 * channel, order total, currency. No customer data exists to leak, which is
 * the easiest way to keep this export App Store safe.
 *
 * Every field goes through `escapeCsvValue`. A value beginning with = + - @
 * is prefixed with a single quote so a spreadsheet treats it as text instead
 * of a formula — channel labels are merchant-authored and a cell containing
 * "=cmd()" must never execute when the merchant opens the file.
 */

export type CsvRow = {
  orderId: string;
  submittedAt: Date;
  channel: string;
  /** null when the order total is unknown. Rendered as an empty cell. */
  orderTotal: string | null;
  currency: string | null;
};

export const CSV_HEADERS = ["order_id", "submitted_at", "channel", "order_total", "currency"] as const;

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
        escapeCsvValue(row.orderId),
        escapeCsvValue(row.submittedAt.toISOString()),
        escapeCsvValue(row.channel),
        escapeCsvValue(row.orderTotal),
        escapeCsvValue(row.currency),
      ].join(","),
    );
  }

  // Trailing newline: some spreadsheet importers drop the final row without it.
  return `${lines.join("\r\n")}\r\n`;
}

export function csvFilename(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return `sourcetrac-responses-${stamp}.csv`;
}

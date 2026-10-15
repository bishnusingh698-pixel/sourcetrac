/**
 * A calendar day in the merchant's language ("15 Oct 2026", "15.10.2026").
 *
 * Formatted in UTC from the ISO string, so the server render and the browser
 * agree and no merchant sees the previous day at a negative UTC offset. An
 * unparseable value falls back to its first ten characters.
 */
export function formatDay(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

/**
 * Calendar dates in a shop's own time zone.
 *
 * A merchant who picks "start 1 March, end 31 March" means midnight to midnight
 * where their store is, both days included. The survey used to store the bare
 * date and compare it as UTC midnight, so an end date in India stopped the
 * survey at 05:30 on that day, in California at 16:00 the day before, and
 * everywhere it lost the last day the merchant picked.
 *
 * Rules are stored as ISO instants: the start is 00:00 on the start date, the
 * end is 00:00 on the day AFTER the end date (exclusive, so the end date runs
 * to its last second). Both are computed in the shop's IANA zone, falling back
 * to UTC. Dependency-free; uses only `Intl`, which knows every zone Shopify
 * reports.
 */

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `Intl` accepts the zone name. */
export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zoneOrUtc(zone: string | null | undefined): string {
  return isValidTimeZone(zone) ? zone : "UTC";
}

/** The wall-clock parts of an instant in a zone. */
function partsIn(instant: Date, zone: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const get = (type: string) => Number(formatter.formatToParts(instant).find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
function offsetMs(instant: Date, zone: string): number {
  const p = partsIn(instant, zone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant of 00:00 on `ymd` in `zone`. Two passes settle the offset across
 * a daylight-saving change; a midnight that does not exist (a few zones skip
 * it) resolves to the first moment of that day.
 */
function midnightIn(ymd: string, zone: string): Date | null {
  const match = YMD.exec(ymd);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const wall = Date.UTC(y, m - 1, d);
  if (Number.isNaN(wall) || new Date(wall).getUTCDate() !== d) return null;
  let guess = wall - offsetMs(new Date(wall), zone);
  guess = wall - offsetMs(new Date(guess), zone);
  return new Date(guess);
}

function addDays(ymd: string, days: number): string {
  const match = YMD.exec(ymd)!;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return date.toISOString().slice(0, 10);
}

/** A start date as the instant the survey starts showing (00:00 in the zone). */
export function startOfDayIso(ymd: string, zone: string | null | undefined): string | null {
  return midnightIn(ymd, zoneOrUtc(zone))?.toISOString() ?? null;
}

/** An end date as the instant the survey stops showing (00:00 the next day). */
export function endOfDayIso(ymd: string, zone: string | null | undefined): string | null {
  if (!YMD.test(ymd)) return null;
  return midnightIn(addDays(ymd, 1), zoneOrUtc(zone))?.toISOString() ?? null;
}

/** The calendar date (YYYY-MM-DD) of an instant in the zone. */
function dateIn(instant: Date, zone: string): string {
  const p = partsIn(instant, zone);
  return `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/**
 * The date to show in a date field for a stored rule. A bare `YYYY-MM-DD` (an
 * older rule) is shown as it was typed.
 */
export function storedToDateField(value: string | null | undefined, edge: "start" | "end", zone: string | null | undefined): string {
  if (!value) return "";
  if (YMD.test(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "";
  // The end is stored as the next midnight; the merchant picked the day before.
  const shown = edge === "end" ? new Date(instant.getTime() - 1) : instant;
  return dateIn(shown, zoneOrUtc(zone));
}

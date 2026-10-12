/**
 * Seasonal spotlight (T15).
 *
 * Evaluated in the ADMIN from this table, the current date in the shop's
 * timezone, and the shop's region pack. No database or network access.
 *
 * Seasons use only widely shared retail moments. Each lists the regions where
 * it applies; banners are translated in all 10 locales.
 */

import type { RegionPack } from "./packs";

export type SeasonId =
  | "year_end_holidays"
  | "bfcm"
  | "valentines"
  | "mothers_day"
  | "new_year";

export type Season = {
  id: SeasonId;
  /** Inclusive start, in the shop's timezone, as MM-DD. */
  start: string;
  /** Inclusive end, as MM-DD. Windows may wrap a year boundary. */
  end: string;
  /** Regions the season applies to. */
  regions: RegionPack[];
  /** The template the spotlight points at. */
  templateId: string;
  /** i18n key for the banner text (`seasons.<id>.banner`). */
  bannerKey: string;
};

/** Order in the table is the tie-break order: the first match wins. */
export const SEASONS: readonly Season[] = [
  {
    id: "year_end_holidays",
    start: "11-01",
    end: "12-20",
    regions: ["us", "global", "eu"],
    templateId: "gift-radar",
    bannerKey: "seasons.year_end_holidays.banner",
  },
  {
    id: "bfcm",
    start: "11-15",
    end: "12-02",
    regions: ["us", "global", "eu"],
    templateId: "channel-compass",
    bannerKey: "seasons.bfcm.banner",
  },
  {
    id: "valentines",
    start: "01-20",
    end: "02-14",
    regions: ["us", "eu"],
    templateId: "gift-radar",
    bannerKey: "seasons.valentines.banner",
  },
  {
    id: "mothers_day",
    start: "04-15",
    end: "05-10",
    regions: ["us"],
    templateId: "gift-radar",
    bannerKey: "seasons.mothers_day.banner",
  },
  {
    id: "new_year",
    start: "01-02",
    end: "01-31",
    regions: ["us", "global", "eu"],
    templateId: "loyalty-pulse",
    bannerKey: "seasons.new_year.banner",
  },
];

/** `MM-DD` for a date, in the given IANA timezone (falls back to UTC). */
export function monthDayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${month}-${day}`;
}

function inWindow(monthDay: string, start: string, end: string): boolean {
  // Windows do not currently wrap the year boundary (Nov–Dec, Jan), but handle
  // it anyway so a future window like 12-20..01-05 is not silently wrong.
  if (start <= end) return monthDay >= start && monthDay <= end;
  return monthDay >= start || monthDay <= end;
}

/**
 * The active season for a shop, or null.
 *
 * If seasons overlap, the first one in table order wins.
 */
export function activeSeason(
  region: RegionPack,
  now: Date,
  timeZone = "UTC",
): Season | null {
  const monthDay = monthDayIn(timeZone, now);
  for (const season of SEASONS) {
    if (!season.regions.includes(region)) continue;
    if (inWindow(monthDay, season.start, season.end)) return season;
  }
  return null;
}

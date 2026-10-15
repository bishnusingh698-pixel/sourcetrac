/**
 * Answer packs — named option lists a question can use, grouped into families
 * (channels, occasions, profiles).
 *
 * Option keys are shared across packs where they mean the same thing (e.g.
 * `instagram`), so results merge cleanly if a merchant switches packs. All
 * labels are translated in all 10 locales; brand names stay untranslated.
 *
 * Dependency-free.
 */

import type { PackFamily, TemplateOption } from "./types";

/** Which concrete pack a family resolves to, given a region. */
export type RegionPack = "us" | "global" | "eu";

/**
 * Region from the shop's country. US and unknown both get US (the default).
 * UK / EU / EEA / Switzerland get UK & Europe; everything else Global.
 */
const EU_COUNTRIES = new Set([
  "GB", "IE", "DE", "FR", "ES", "IT", "NL", "BE", "AT", "PT", "SE", "DK",
  "FI", "NO", "PL", "CZ", "SK", "HU", "RO", "BG", "GR", "HR", "SI", "EE",
  "LV", "LT", "LU", "MT", "CY", "CH", "IS", "LI",
]);

export function regionPackFor(country: string | null | undefined): RegionPack {
  if (!country) return "us";
  const code = country.trim().toUpperCase();
  if (code === "US" || code === "") return "us";
  if (EU_COUNTRIES.has(code)) return "eu";
  return "global";
}

/** A pack is a list of options, always ending in "Other (please specify)". */
export type Pack = {
  id: string;
  /** Pack family this belongs to. */
  family: PackFamily;
  /** Set for the three region packs; undefined for profile packs. */
  region?: RegionPack;
  /** The profile question text key, for profile packs. */
  questionTextKey?: string;
  options: TemplateOption[];
};

function opt(key: string, labelKey: string): TemplateOption {
  return { key, labelKey };
}

const OTHER = opt("other", "packs.option_other");

/** The three channel packs. Keys are shared where the meaning matches. */
const CHANNELS: Record<RegionPack, Pack> = {
  us: {
    id: "channels_us",
    family: "channels",
    region: "us",
    options: [
      opt("instagram", "packs.channel_instagram"),
      opt("tiktok", "packs.channel_tiktok"),
      opt("youtube", "packs.channel_youtube"),
      opt("google", "packs.channel_google"),
      opt("facebook", "packs.channel_facebook"),
      opt("friend_family", "packs.channel_friend_family"),
      opt("creator_influencer", "packs.channel_creator"),
      opt("podcast", "packs.channel_podcast"),
      opt("ai_assistant", "packs.channel_ai"),
      OTHER,
    ],
  },
  global: {
    id: "channels_global",
    family: "channels",
    region: "global",
    options: [
      opt("instagram", "packs.channel_instagram"),
      opt("tiktok", "packs.channel_tiktok"),
      opt("youtube", "packs.channel_youtube"),
      opt("google", "packs.channel_google"),
      opt("facebook", "packs.channel_facebook"),
      opt("friend_family", "packs.channel_friend_family"),
      opt("creator_influencer", "packs.channel_creator"),
      opt("online_marketplace", "packs.channel_marketplace"),
      opt("ai_assistant", "packs.channel_ai"),
      OTHER,
    ],
  },
  eu: {
    id: "channels_eu",
    family: "channels",
    region: "eu",
    options: [
      opt("instagram", "packs.channel_instagram"),
      opt("tiktok", "packs.channel_tiktok"),
      opt("youtube", "packs.channel_youtube"),
      opt("google", "packs.channel_google"),
      opt("facebook", "packs.channel_facebook"),
      opt("friend_family", "packs.channel_friend_family"),
      opt("creator_influencer", "packs.channel_creator"),
      opt("podcast", "packs.channel_podcast"),
      opt("ai_assistant", "packs.channel_ai"),
      OTHER,
    ],
  },
};

const OCCASIONS: Record<RegionPack, Pack> = {
  us: {
    id: "occasions_us",
    family: "occasions",
    region: "us",
    options: [
      opt("birthday", "packs.occasion_birthday"),
      opt("anniversary", "packs.occasion_anniversary"),
      opt("wedding", "packs.occasion_wedding"),
      opt("holidays", "packs.occasion_holidays"),
      opt("mothers_fathers_day", "packs.occasion_mothers_fathers"),
      opt("valentines", "packs.occasion_valentines"),
      opt("graduation", "packs.occasion_graduation"),
      opt("just_because", "packs.occasion_just_because"),
      OTHER,
    ],
  },
  global: {
    id: "occasions_global",
    family: "occasions",
    region: "global",
    options: [
      opt("birthday", "packs.occasion_birthday"),
      opt("anniversary", "packs.occasion_anniversary"),
      opt("wedding", "packs.occasion_wedding"),
      opt("holiday_festival", "packs.occasion_holiday_festival"),
      opt("new_baby", "packs.occasion_new_baby"),
      opt("thank_you_gift", "packs.occasion_thank_you"),
      opt("just_because", "packs.occasion_just_because"),
      OTHER,
    ],
  },
  eu: {
    id: "occasions_eu",
    family: "occasions",
    region: "eu",
    options: [
      opt("birthday", "packs.occasion_birthday"),
      opt("anniversary", "packs.occasion_anniversary"),
      opt("wedding", "packs.occasion_wedding"),
      opt("christmas_holidays", "packs.occasion_christmas"),
      opt("mothers_fathers_day", "packs.occasion_mothers_fathers"),
      opt("valentines", "packs.occasion_valentines"),
      opt("just_because", "packs.occasion_just_because"),
      OTHER,
    ],
  },
};

/** Profile packs are the same for every region. Preferences only, never health. */
const PROFILES: Record<string, Pack> = {
  profiles_beauty: {
    id: "profile_beauty",
    family: "profiles_beauty",
    questionTextKey: "packs.profile_beauty_question",
    options: [
      opt("dry", "packs.profile_beauty_dry"),
      opt("oily", "packs.profile_beauty_oily"),
      opt("combination", "packs.profile_beauty_combination"),
      opt("sensitive", "packs.profile_beauty_sensitive"),
      opt("normal", "packs.profile_beauty_normal"),
      opt("not_sure", "packs.profile_beauty_not_sure"),
    ],
  },
  profiles_fashion: {
    id: "profile_fashion",
    family: "profiles_fashion",
    questionTextKey: "packs.profile_fashion_question",
    options: [
      opt("classic", "packs.profile_fashion_classic"),
      opt("casual", "packs.profile_fashion_casual"),
      opt("streetwear", "packs.profile_fashion_streetwear"),
      opt("minimal", "packs.profile_fashion_minimal"),
      opt("bold_colorful", "packs.profile_fashion_bold"),
      opt("sporty", "packs.profile_fashion_sporty"),
      OTHER,
    ],
  },
  profiles_food: {
    id: "profile_food",
    family: "profiles_food",
    questionTextKey: "packs.profile_food_question",
    options: [
      opt("vegetarian", "packs.profile_food_vegetarian"),
      opt("vegan", "packs.profile_food_vegan"),
      opt("pescatarian", "packs.profile_food_pescatarian"),
      opt("everything", "packs.profile_food_everything"),
      opt("high_protein", "packs.profile_food_high_protein"),
      OTHER,
    ],
  },
  profiles_pets: {
    id: "profile_pets",
    family: "profiles_pets",
    questionTextKey: "packs.profile_pets_question",
    options: [
      opt("dog", "packs.profile_pets_dog"),
      opt("cat", "packs.profile_pets_cat"),
      opt("both", "packs.profile_pets_both"),
      opt("other_pet", "packs.profile_pets_other"),
    ],
  },
  profiles_home: {
    id: "profile_home",
    family: "profiles_home",
    questionTextKey: "packs.profile_home_question",
    options: [
      opt("living_room", "packs.profile_home_living"),
      opt("bedroom", "packs.profile_home_bedroom"),
      opt("kitchen", "packs.profile_home_kitchen"),
      opt("bathroom", "packs.profile_home_bathroom"),
      opt("home_office", "packs.profile_home_office"),
      opt("outdoor", "packs.profile_home_outdoor"),
      OTHER,
    ],
  },
};

/** Every profile pack, for the Taste Profile picker. */
export const PROFILE_PACK_IDS = [
  "profiles_beauty",
  "profiles_fashion",
  "profiles_food",
  "profiles_pets",
  "profiles_home",
] as const;

/**
 * Resolve a family + region to a concrete pack.
 *
 * Profile families ignore the region (the same list everywhere). Channel and
 * occasion families pick by region.
 */
export function packFor(family: PackFamily, region: RegionPack): Pack {
  if (family === "channels") return CHANNELS[region];
  if (family === "occasions") return OCCASIONS[region];
  return PROFILES[family]!;
}

export function packById(id: string): Pack | undefined {
  for (const region of ["us", "global", "eu"] as RegionPack[]) {
    if (CHANNELS[region].id === id) return CHANNELS[region];
    if (OCCASIONS[region].id === id) return OCCASIONS[region];
  }
  return Object.values(PROFILES).find((p) => p.id === id);
}

/** All packs, for the locale parity test and the answer-pack picker. */
export const ALL_PACKS: readonly Pack[] = [
  CHANNELS.us,
  CHANNELS.global,
  CHANNELS.eu,
  OCCASIONS.us,
  OCCASIONS.global,
  OCCASIONS.eu,
  ...Object.values(PROFILES),
];

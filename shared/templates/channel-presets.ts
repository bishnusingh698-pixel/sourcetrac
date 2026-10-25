/**
 * "How did you hear about us?" answers for each market.
 *
 * The apps and sites buyers discover shops on differ by country: LINE and
 * Yahoo! JAPAN in Japan, Naver and KakaoTalk in Korea, WeChat and Xiaohongshu in
 * China, Snapchat across the Gulf, WhatsApp and Mercado Libre in Latin America.
 * A US list shown to a Korean store's buyers leaves most of them picking
 * "Other". Each market lists its usual channels, most-used first, at most nine
 * so "Other" still fits under the ten-answer limit.
 *
 * Brand names are written as the brands write them and never translated.
 * Generic answers ("Friend or family", "Podcast") name a template locale key,
 * so a survey built from a preset carries their wording in every template
 * language, like a template does.
 *
 * Every option has a stable `key`. A survey stores it on the option as
 * `templateKey`, so "Instagram" from a preset, from a template and from another
 * survey is one channel in the reports (see `readableChannelKey`).
 *
 * The lists are a starting point the merchant edits, not research claims.
 * Dependency-free, like the rest of `shared/templates`.
 */

export type PresetOption = {
  /** Stable channel key, shared with the template packs where they overlap. */
  key: string;
  /** A brand name, shown as written in every language. */
  brand?: string;
  /** A template locale key for a generic answer. */
  labelKey?: string;
};

export type ChannelMarket = {
  /** Stable id; also the admin i18n suffix `presets.market_<id>`. */
  id: string;
  /** ISO 3166-1 alpha-2 codes this market covers. */
  countries: readonly string[];
  options: readonly PresetOption[];
};

const brand = (key: string, name: string): PresetOption => ({ key, brand: name });
const generic = (key: string, labelKey: string): PresetOption => ({ key, labelKey });

const INSTAGRAM = brand("instagram", "Instagram");
const TIKTOK = brand("tiktok", "TikTok");
const FACEBOOK = brand("facebook", "Facebook");
const YOUTUBE = brand("youtube", "YouTube");
const PINTEREST = brand("pinterest", "Pinterest");
const SNAPCHAT = brand("snapchat", "Snapchat");
const WHATSAPP = brand("whatsapp", "WhatsApp");
const TELEGRAM = brand("telegram", "Telegram");
const X = brand("x_twitter", "X (Twitter)");
const THREADS = brand("threads", "Threads");
const LINE = brand("line", "LINE");
const GOOGLE = generic("google", "packs.channel_google");
const FRIEND = generic("friend_family", "packs.channel_friend_family");
const CREATOR = generic("creator_influencer", "packs.channel_creator");
const PODCAST = generic("podcast", "packs.channel_podcast");
const AI = generic("ai_assistant", "packs.channel_ai");
const MARKETPLACE = generic("online_marketplace", "packs.channel_marketplace");
const TV = generic("tv", "packs.channel_tv");
const STORE = generic("store_event", "packs.channel_store");
const EMAIL = generic("email", "packs.channel_email");

/** Every market, in the order the picker groups them. `global` is the fallback. */
export const CHANNEL_MARKETS: readonly ChannelMarket[] = [
  {
    id: "us",
    countries: ["US", "PR", "GU", "VI", "AS", "MP", "UM"],
    options: [INSTAGRAM, TIKTOK, FACEBOOK, GOOGLE, YOUTUBE, FRIEND, CREATOR, PODCAST, AI],
  },
  {
    id: "ca",
    countries: ["CA"],
    options: [INSTAGRAM, FACEBOOK, GOOGLE, TIKTOK, YOUTUBE, FRIEND, CREATOR, PODCAST, STORE],
  },
  {
    id: "uk_ie",
    countries: ["GB", "IE", "IM", "JE", "GG", "GI"],
    options: [INSTAGRAM, TIKTOK, FACEBOOK, GOOGLE, YOUTUBE, FRIEND, CREATOR, PODCAST, TV],
  },
  {
    id: "dach",
    countries: ["DE", "AT", "CH", "LI"],
    options: [INSTAGRAM, GOOGLE, FACEBOOK, YOUTUBE, TIKTOK, PINTEREST, FRIEND, CREATOR, MARKETPLACE],
  },
  {
    id: "france",
    countries: ["FR", "MC", "RE", "GP", "MQ", "GF", "YT", "PF", "NC", "PM", "BL", "MF", "WF"],
    options: [INSTAGRAM, FACEBOOK, GOOGLE, TIKTOK, YOUTUBE, SNAPCHAT, PINTEREST, FRIEND, CREATOR],
  },
  {
    id: "benelux",
    countries: ["NL", "BE", "LU"],
    options: [INSTAGRAM, FACEBOOK, GOOGLE, TIKTOK, YOUTUBE, PINTEREST, FRIEND, CREATOR, MARKETPLACE],
  },
  {
    id: "southern_europe",
    countries: ["ES", "PT", "IT", "GR", "MT", "CY", "AD", "SM", "VA"],
    options: [INSTAGRAM, FACEBOOK, GOOGLE, TIKTOK, YOUTUBE, WHATSAPP, FRIEND, CREATOR, TV],
  },
  {
    id: "nordics",
    countries: ["SE", "NO", "DK", "FI", "IS", "FO", "GL", "AX", "SJ"],
    options: [INSTAGRAM, FACEBOOK, GOOGLE, TIKTOK, YOUTUBE, SNAPCHAT, FRIEND, CREATOR, PODCAST],
  },
  {
    id: "eastern_europe",
    countries: [
      "PL", "CZ", "SK", "HU", "RO", "BG", "HR", "SI", "EE", "LV", "LT", "UA", "RS", "BA", "ME", "MK", "AL", "MD", "XK",
    ],
    options: [INSTAGRAM, FACEBOOK, GOOGLE, TIKTOK, YOUTUBE, TELEGRAM, FRIEND, CREATOR, MARKETPLACE],
  },
  {
    id: "cis",
    countries: ["RU", "BY", "KZ", "UZ", "KG", "TJ", "AM", "AZ", "GE", "TM", "MN"],
    options: [
      TELEGRAM,
      brand("vk", "VK"),
      YOUTUBE,
      brand("yandex", "Yandex"),
      INSTAGRAM,
      FRIEND,
      CREATOR,
      MARKETPLACE,
      STORE,
    ],
  },
  {
    id: "japan",
    countries: ["JP"],
    options: [
      INSTAGRAM,
      X,
      LINE,
      YOUTUBE,
      GOOGLE,
      brand("yahoo_japan", "Yahoo! JAPAN"),
      TIKTOK,
      FRIEND,
      brand("rakuten_amazon", "Rakuten / Amazon"),
    ],
  },
  {
    id: "korea",
    countries: ["KR"],
    options: [
      INSTAGRAM,
      brand("naver", "Naver"),
      brand("kakaotalk", "KakaoTalk"),
      YOUTUBE,
      GOOGLE,
      TIKTOK,
      brand("coupang", "Coupang"),
      FRIEND,
      CREATOR,
    ],
  },
  {
    id: "china",
    countries: ["CN"],
    options: [
      brand("wechat", "WeChat (微信)"),
      brand("xiaohongshu", "Xiaohongshu (小红书)"),
      brand("douyin", "Douyin (抖音)"),
      brand("weibo", "Weibo (微博)"),
      brand("bilibili", "Bilibili (哔哩哔哩)"),
      brand("baidu", "Baidu (百度)"),
      brand("taobao_tmall", "Taobao / Tmall"),
      FRIEND,
      CREATOR,
    ],
  },
  {
    id: "greater_china",
    countries: ["TW", "HK", "MO"],
    options: [INSTAGRAM, FACEBOOK, LINE, YOUTUBE, GOOGLE, THREADS, brand("xiaohongshu", "Xiaohongshu (小红书)"), FRIEND, CREATOR],
  },
  {
    id: "southeast_asia",
    countries: ["SG", "MY", "TH", "ID", "PH", "VN", "KH", "LA", "MM", "BN", "TL"],
    options: [
      INSTAGRAM,
      FACEBOOK,
      TIKTOK,
      YOUTUBE,
      GOOGLE,
      brand("shopee_lazada", "Shopee / Lazada"),
      WHATSAPP,
      FRIEND,
      CREATOR,
    ],
  },
  {
    id: "south_asia",
    countries: ["IN", "PK", "BD", "LK", "NP", "BT", "MV"],
    options: [INSTAGRAM, YOUTUBE, WHATSAPP, FACEBOOK, GOOGLE, MARKETPLACE, FRIEND, CREATOR, AI],
  },
  {
    id: "middle_east",
    countries: [
      "AE", "SA", "QA", "KW", "BH", "OM", "EG", "JO", "LB", "IQ", "YE", "SY", "PS", "MA", "DZ", "TN", "LY", "SD", "IR",
    ],
    options: [SNAPCHAT, INSTAGRAM, TIKTOK, WHATSAPP, X, YOUTUBE, GOOGLE, FRIEND, CREATOR],
  },
  {
    id: "israel",
    countries: ["IL"],
    options: [INSTAGRAM, FACEBOOK, TIKTOK, GOOGLE, YOUTUBE, WHATSAPP, FRIEND, CREATOR, PODCAST],
  },
  {
    id: "turkey",
    countries: ["TR"],
    options: [INSTAGRAM, YOUTUBE, TIKTOK, GOOGLE, X, FACEBOOK, WHATSAPP, FRIEND, MARKETPLACE],
  },
  {
    id: "brazil",
    countries: ["BR"],
    options: [INSTAGRAM, WHATSAPP, TIKTOK, YOUTUBE, GOOGLE, FACEBOOK, brand("mercado_libre", "Mercado Livre"), FRIEND, CREATOR],
  },
  {
    id: "latin_america",
    countries: [
      "MX", "AR", "CO", "CL", "PE", "EC", "UY", "PY", "BO", "VE", "CR", "PA", "GT", "HN", "SV", "NI", "DO", "CU",
      "JM", "TT", "BS", "BB", "HT", "BZ", "GY", "SR", "AW", "CW", "KY", "BM", "AG", "DM", "GD", "KN", "LC", "VC",
      "BQ", "SX", "TC", "VG", "AI", "MS", "FK",
    ],
    options: [INSTAGRAM, FACEBOOK, TIKTOK, WHATSAPP, YOUTUBE, GOOGLE, brand("mercado_libre", "Mercado Libre"), FRIEND, CREATOR],
  },
  {
    id: "oceania",
    countries: ["AU", "NZ", "FJ", "PG", "WS", "TO", "VU", "SB", "KI", "TV", "NR", "FM", "MH", "PW", "CK", "NU", "NF", "CX", "CC"],
    options: [INSTAGRAM, FACEBOOK, TIKTOK, GOOGLE, YOUTUBE, FRIEND, CREATOR, PODCAST, TV],
  },
  {
    id: "africa",
    countries: [
      "ZA", "NG", "KE", "GH", "TZ", "UG", "ET", "RW", "CI", "SN", "CM", "ZM", "ZW", "BW", "NA", "MZ", "AO", "MU",
      "MG", "MW", "BJ", "BF", "ML", "NE", "TG", "GN", "SL", "LR", "GM", "GA", "CG", "CD", "CF", "TD", "SS", "SO",
      "DJ", "ER", "LS", "SZ", "CV", "ST", "GQ", "KM", "SC", "BI", "GW", "MR", "EH",
    ],
    options: [WHATSAPP, FACEBOOK, INSTAGRAM, TIKTOK, YOUTUBE, GOOGLE, X, FRIEND, CREATOR],
  },
  {
    id: "global",
    countries: [],
    options: [INSTAGRAM, TIKTOK, YOUTUBE, GOOGLE, FACEBOOK, FRIEND, CREATOR, MARKETPLACE, EMAIL],
  },
];

const BY_COUNTRY = new Map<string, ChannelMarket>();
for (const market of CHANNEL_MARKETS) {
  for (const code of market.countries) if (!BY_COUNTRY.has(code)) BY_COUNTRY.set(code, market);
}

/** The global list, used for any country no market lists. */
export const GLOBAL_MARKET: ChannelMarket = CHANNEL_MARKETS.find((m) => m.id === "global")!;

/** The market a country belongs to (`global` when none lists it). */
export function marketForCountry(country: string | null | undefined): ChannelMarket {
  if (!country) return CHANNEL_MARKETS[0]!;
  return BY_COUNTRY.get(country.trim().toUpperCase()) ?? GLOBAL_MARKET;
}

/** Every template locale key a preset can use, so the server can resolve them in one pass. */
export const PRESET_LABEL_KEYS: readonly string[] = [
  ...new Set(CHANNEL_MARKETS.flatMap((m) => m.options.flatMap((o) => (o.labelKey ? [o.labelKey] : [])))),
];

/** The option's `templateKey` on a question with no template key of its own. */
export const PRESET_TEMPLATE_KEY_PREFIX = "preset:";

/**
 * The `templateKey` an option loaded from a preset is saved with. Inside a
 * template's question it follows that template's own pattern
 * (`<questionKey>_<key>`), so the template's tags and ideas still recognise
 * it; elsewhere it is `preset:<key>`. Either way the reports read back `key`.
 */
export function presetOptionTemplateKey(questionTemplateKey: string | null | undefined, key: string): string {
  return questionTemplateKey ? `${questionTemplateKey}_${key}` : `${PRESET_TEMPLATE_KEY_PREFIX}${key}`;
}

/** The label of a preset option in one language, given a template-text lookup. */
export function presetLabel(option: PresetOption, text: (key: string) => string): string {
  return option.brand ?? text(option.labelKey ?? "");
}

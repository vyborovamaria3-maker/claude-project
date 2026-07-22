export const SOURCE_LOCALE = "en";
export const LOCALE_STORAGE_KEY = "site.locale";
export const LOCALE_COOKIE_NAME = "site.locale";
export const PENDING_LOCALE_STORAGE_KEY = "site.locale.pending";

export const SUPPORTED_LOCALES = ["en", "es", "fr", "de", "it", "pt", "ru", "ar", "he", "ja", "ko", "zh"] as const;

const RTL_LOCALES = new Set(["ar", "he", "fa", "ur", "ps", "yi"]);
const LOCALE_FLAG_COUNTRY_CODES: Record<string, string> = {
  af: "za",
  am: "et",
  ar: "sa",
  az: "az",
  be: "by",
  bg: "bg",
  bn: "bd",
  bs: "ba",
  ca: "es",
  ceb: "ph",
  cs: "cz",
  cy: "gb",
  da: "dk",
  de: "de",
  el: "gr",
  en: "us",
  es: "es",
  et: "ee",
  eu: "es",
  fa: "ir",
  fi: "fi",
  fr: "fr",
  fy: "nl",
  ga: "ie",
  gd: "gb",
  gl: "es",
  gu: "in",
  ha: "ng",
  he: "il",
  hi: "in",
  hr: "hr",
  ht: "ht",
  hu: "hu",
  hy: "am",
  id: "id",
  ig: "ng",
  is: "is",
  it: "it",
  ja: "jp",
  jw: "id",
  ka: "ge",
  kk: "kz",
  km: "kh",
  kn: "in",
  ko: "kr",
  ku: "tr",
  ky: "kg",
  la: "va",
  lb: "lu",
  lo: "la",
  lt: "lt",
  lv: "lv",
  mg: "mg",
  mi: "nz",
  mk: "mk",
  ml: "in",
  mn: "mn",
  mr: "in",
  ms: "my",
  mt: "mt",
  my: "mm",
  ne: "np",
  no: "no",
  ny: "mw",
  or: "in",
  pa: "in",
  pl: "pl",
  ps: "af",
  pt: "pt",
  ro: "ro",
  ru: "ru",
  sd: "pk",
  si: "lk",
  sk: "sk",
  sl: "si",
  sm: "ws",
  sn: "zw",
  so: "so",
  sq: "al",
  sr: "rs",
  st: "za",
  su: "id",
  sv: "se",
  sw: "tz",
  ta: "in",
  te: "in",
  tg: "tj",
  th: "th",
  tl: "ph",
  tr: "tr",
  uk: "ua",
  ur: "pk",
  uz: "uz",
  vi: "vn",
  xh: "za",
  yi: "il",
  yo: "ng",
  zh: "cn",
  zu: "za",
};

function countryCodeToFlagEmoji(countryCode: string) {
  const code = countryCode.toLowerCase().trim();

  if (code.length !== 2) return "�";

  const first = code.charCodeAt(0) - 97 + 0x1f1e6;
  const second = code.charCodeAt(1) - 97 + 0x1f1e6;

  if (first < 0x1f1e6 || second < 0x1f1e6) return "�";

  return String.fromCodePoint(first, second);
}

export function normalizeLocale(value?: string | null) {
  return (value ?? SOURCE_LOCALE).toLowerCase().trim().replace("_", "-").split("-")[0];
}

export function isSupportedLocale(value?: string | null): value is (typeof SUPPORTED_LOCALES)[number] {
  return SUPPORTED_LOCALES.includes(normalizeLocale(value) as (typeof SUPPORTED_LOCALES)[number]);
}

export function resolveSupportedLocale(value?: string | null) {
  const normalized = normalizeLocale(value);
  return isSupportedLocale(normalized) ? normalized : SOURCE_LOCALE;
}

export function isRtlLocale(value?: string | null) {
  return RTL_LOCALES.has(normalizeLocale(value));
}

export function getLocaleFlagCountryCode(code: string) {
  const normalized = normalizeLocale(code);

  return LOCALE_FLAG_COUNTRY_CODES[normalized] ?? "us";
}

export function getLocaleLabel(code: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(normalizeLocale(code)) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function detectBrowserLocale() {
  if (typeof navigator === "undefined") return SOURCE_LOCALE;

  const preferred = [...navigator.languages, navigator.language].filter(Boolean);

  for (const locale of preferred) {
    const normalized = normalizeLocale(locale);
    if (isSupportedLocale(normalized)) return normalized;
  }

  return SOURCE_LOCALE;
}

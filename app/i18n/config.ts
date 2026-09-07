/**
 * Locales Mannon ships. Arabic is a first-class locale, not an afterthought:
 * the storefront and admin both mirror for RTL, and Arabic's six plural forms
 * are why translation goes through i18next rather than a lookup table.
 */
export const SUPPORTED_LOCALES = ["en", "ar"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const DEFAULT_NAMESPACE = "common";

/** Locales written right-to-left. */
const RTL_LOCALES = new Set<Locale>(["ar"]);

export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export function dirFor(locale: Locale): "ltr" | "rtl" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

/**
 * Shopify sends locales like "ar-SA" or "en-GB"; we ship the base language.
 * Returns undefined for anything unsupported so callers can fall through.
 */
export function normalizeLocale(value: string | null | undefined): Locale | undefined {
  if (!value) return undefined;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return isSupportedLocale(base) ? base : undefined;
}

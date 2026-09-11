/**
 * Locales Mannon ships. Arabic is a first-class locale, not an afterthought:
 * the storefront and admin both mirror for RTL, and Arabic's six plural forms
 * are why translation goes through i18next rather than a lookup table.
 */
export const SUPPORTED_LOCALES = ["en", "ar"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/**
 * What to call each language when asking a model to translate into it.
 *
 * Endonyms rather than codes: "Arabic" is what the prompt should say, and a
 * two-letter code is a thing a model has to guess about.
 */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: "English",
  ar: "Arabic",
};
export const DEFAULT_NAMESPACE = "common";

/**
 * Where a shop's own wording lives.
 *
 * A second namespace rather than an edit to the first. i18next's
 * `addResource` writes **into the resource object it was handed** — and this
 * process hands it the imported `en.json`, so one shop saving a string
 * rewrote the shipped catalogue for every later request and every other
 * tenant, outbound, to their buyers. Overrides are their own layer now: built
 * fresh per instance, looked up first, falling back to `common`.
 */
export const OVERRIDE_NAMESPACE = "shop";

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

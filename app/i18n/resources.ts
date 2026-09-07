import ar from "~/i18n/locales/ar.json";
import en from "~/i18n/locales/en.json";

import { DEFAULT_NAMESPACE, type Locale } from "~/i18n/config";

/**
 * Catalogs are bundled rather than fetched. They are small, and shipping them
 * with the app removes a network round trip on first paint — which matters
 * because the alternative is a flash of untranslated text inside the admin
 * iframe, and Built for Shopify measures CLS.
 */
export const resources: Record<Locale, Record<string, typeof en>> = {
  en: { [DEFAULT_NAMESPACE]: en },
  ar: { [DEFAULT_NAMESPACE]: ar as typeof en },
};

/** English is the source of truth for what keys exist. */
export type TranslationCatalog = typeof en;

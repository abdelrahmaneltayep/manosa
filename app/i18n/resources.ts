import type { Resource } from "i18next";

import ar from "~/i18n/locales/ar.json";
import en from "~/i18n/locales/en.json";

import { DEFAULT_NAMESPACE } from "~/i18n/config";

/**
 * Catalogs are bundled rather than fetched. They are small, and shipping them
 * with the app removes a network round trip on first paint — which matters
 * because the alternative is a flash of untranslated text inside the admin
 * iframe, and Built for Shopify measures CLS.
 *
 * The two catalogs are deliberately not the same shape: English pluralises
 * into `one`/`other`, Arabic into `zero`/`one`/`two`/`few`/`many`/`other`.
 * i18next selects the right suffix per language, so this is typed as i18next's
 * own Resource rather than forced into English's shape.
 * `tests/unit/i18n-catalogs.test.ts` is what keeps them in step.
 */
export const resources: Resource = {
  en: { [DEFAULT_NAMESPACE]: en },
  ar: { [DEFAULT_NAMESPACE]: ar },
};

/** English is the source of truth for what keys exist. */
export type TranslationCatalog = typeof en;

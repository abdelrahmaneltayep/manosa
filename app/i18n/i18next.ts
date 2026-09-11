import { createInstance, type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";

import {
  DEFAULT_NAMESPACE,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type Locale,
} from "~/i18n/config";
import { resources } from "~/i18n/resources";

/**
 * One i18next instance per server request, one for the life of the client.
 *
 * Server-side must not share an instance across requests: two shops rendering
 * in different languages at the same time would race on the global language.
 */
export async function createI18n(
  locale: Locale,
  /**
   * The shop's own wording for storefront strings, flat: `{"forms.submit": …}`.
   *
   * Applied on top of the shipped catalogue rather than instead of it, so a
   * merchant who rewrites three strings is not suddenly responsible for five
   * hundred — and applied **here**, in the one place an instance is built, so
   * there is no surface that can translate without them.
   */
  overrides: Record<string, string> = {},
): Promise<I18n> {
  const instance = createInstance();

  await instance.use(initReactI18next).init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    defaultNS: DEFAULT_NAMESPACE,
    ns: [DEFAULT_NAMESPACE],
    resources,
    interpolation: {
      // React escapes for us; double-escaping turns an apostrophe into &#39;.
      escapeValue: false,
    },
    react: { useSuspense: false },
  });

  for (const [key, value] of Object.entries(overrides)) {
    // Dotted keys are a path in i18next's own tree, so each is set on its own
    // rather than merged as an object — a flat `{"forms.submit": …}` bundle
    // would create a literal key with dots in it and silently never match.
    instance.addResource(locale, DEFAULT_NAMESPACE, key, value);
  }

  return instance;
}

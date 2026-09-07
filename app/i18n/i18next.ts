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
export async function createI18n(locale: Locale): Promise<I18n> {
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

  return instance;
}

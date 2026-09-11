import { createInstance, type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";

import {
  DEFAULT_NAMESPACE,
  DEFAULT_LOCALE,
  OVERRIDE_NAMESPACE,
  SUPPORTED_LOCALES,
  type Locale,
} from "~/i18n/config";
import { resources } from "~/i18n/resources";

/**
 * One i18next instance per request, one for the life of the client.
 *
 * Server-side must not share an instance across requests: two shops rendering
 * in different languages at the same time would race on the global language.
 */

/**
 * A flat `{"forms.public.submit": …}` map as the tree i18next reads.
 *
 * Dots are a *path* to i18next, so a flat bundle would create a literal key
 * with dots in it that nothing ever looks up. Built fresh on every call, into
 * an object this module owns — the shipped catalogue is never written to.
 */
function treeOf(overrides: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(overrides)) {
    const parts = key.split(".");
    const leaf = parts.pop();
    if (leaf === undefined || leaf === "") continue;

    let node = root;
    for (const part of parts) {
      const next = node[part];
      if (typeof next !== "object" || next === null) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[leaf] = value;
  }

  return root;
}

export function createI18nSync(
  locale: Locale,
  /**
   * The shop's own wording for buyer-facing strings, flat:
   * `{"forms.public.submit": …}`.
   *
   * Applied as a layer on top of the shipped catalogue rather than instead of
   * it, so a merchant who rewrites three strings is not suddenly responsible
   * for five hundred — and applied **here**, where an instance is built, so no
   * surface can translate without them.
   */
  overrides: Record<string, string> = {},
): I18n {
  const instance = createInstance();

  // Synchronous: every catalogue is bundled and there is no backend to wait
  // for, so `init` completes before it returns. That is what lets a React
  // component build one during render — which is how a buyer-facing route
  // hands its own subtree the shop's wording without a second round trip.
  instance.use(initReactI18next).init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    // The shop's layer is looked up first and falls through to what Mannon
    // ships, per key — so overriding `quotes.expiresIn_one` leaves the other
    // five Arabic plural categories exactly as they were.
    defaultNS: OVERRIDE_NAMESPACE,
    fallbackNS: DEFAULT_NAMESPACE,
    ns: [OVERRIDE_NAMESPACE, DEFAULT_NAMESPACE],
    resources: {
      ...Object.fromEntries(
        SUPPORTED_LOCALES.map((code) => [
          code,
          {
            ...resources[code],
            // Only this locale's overrides: another language's wording is
            // another language's, and i18next would fall back into it.
            [OVERRIDE_NAMESPACE]: code === locale ? treeOf(overrides) : {},
          },
        ]),
      ),
    },
    interpolation: {
      // React escapes for us; double-escaping turns an apostrophe into &#39;.
      escapeValue: false,
    },
    react: { useSuspense: false },
  });

  return instance;
}

/** The same instance, for callers that were already awaiting one. */
export async function createI18n(
  locale: Locale,
  overrides: Record<string, string> = {},
): Promise<I18n> {
  return createI18nSync(locale, overrides);
}

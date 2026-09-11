import type { TFunction } from "i18next";

import {
  DEFAULT_LOCALE,
  normalizeLocale,
  OVERRIDE_NAMESPACE,
  type Locale,
} from "~/i18n/config";
import { createI18n } from "~/i18n/i18next";
import { overridesFor } from "~/lib/i18n/strings.server";

/**
 * Work out which language to render in.
 *
 * Order, and why:
 *  1. `?locale=` — Shopify puts the staff member's admin language on every
 *     embedded document request. Inside the admin this is the authoritative
 *     answer, and it costs nothing to read.
 *  2. `Accept-Language` — the unembedded install page and any direct visit.
 *  3. English.
 *
 * Deliberately no cookie: third-party cookies are unreliable inside the admin
 * iframe, which is the whole reason App Bridge exists. Anything that needs a
 * language server-side after the first paint (emails, agent replies) reads the
 * shop's stored locale instead — see `getShopT`.
 */
export function detectLocale(request: Request): Locale {
  const url = new URL(request.url);

  const fromQuery = normalizeLocale(url.searchParams.get("locale"));
  if (fromQuery) return fromQuery;

  const header = request.headers.get("accept-language");
  if (header) {
    for (const part of header.split(",")) {
      const tag = part.split(";")[0];
      const candidate = normalizeLocale(tag);
      if (candidate) return candidate;
    }
  }

  return DEFAULT_LOCALE;
}

/** A `t` bound to one locale, for translating on the server. */
export async function getFixedT(locale: Locale): Promise<TFunction> {
  // The shop's own wording, when there is a shop. `overridesFor` returns
  // nothing outside a tenant scope — the login page and the error boundary
  // both translate without one — so this is the same call everywhere rather
  // than two paths, one of which would eventually forget.
  const instance = await createI18n(locale, await overridesFor(locale));
  // Bound to the shop's own layer, which falls through to `common` per key.
  // Binding to `common` directly is how a `t` skips every override.
  return instance.getFixedT(locale, OVERRIDE_NAMESPACE);
}

/**
 * Translate in the shop's own language rather than the current viewer's.
 *
 * Use this for anything a buyer will read — notification emails, agent
 * replies, storefront copy — where "whoever happened to open the admin" is the
 * wrong answer. Takes the locale explicitly so it works from jobs and webhooks,
 * which have no request.
 */
export async function getShopT(primaryLocale: string): Promise<TFunction> {
  return getFixedT(normalizeLocale(primaryLocale) ?? DEFAULT_LOCALE);
}

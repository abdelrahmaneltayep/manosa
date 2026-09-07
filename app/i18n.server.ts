import type { TFunction } from "i18next";

import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  normalizeLocale,
  type Locale,
} from "~/i18n/config";
import { createI18n } from "~/i18n/i18next";

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
  const instance = await createI18n(locale);
  return instance.getFixedT(locale, DEFAULT_NAMESPACE);
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

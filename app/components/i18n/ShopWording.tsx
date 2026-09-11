import { useMemo } from "react";
import { I18nextProvider } from "react-i18next";

import type { Locale } from "~/i18n/config";
import { createI18nSync } from "~/i18n/i18next";

/**
 * The merchant's own wording, for the pages a buyer actually reads.
 *
 * The instance `entry.server.tsx` and `entry.client.tsx` build knows nothing
 * about any shop — it cannot: `/f/:publicId` and `/q/:publicId` identify their
 * shop from a row in the database, which only the route's own loader has
 * looked up. So the two buyer-facing routes provide their own instance over
 * their own subtree, from overrides their loader returned.
 *
 * The same loader data reaches the server render and the hydration, so the two
 * agree — which matters more here than anywhere else in the app: a buyer
 * watching the merchant's wording flip back to Mannon's on hydration is worse
 * than never having seen it.
 *
 * Admin pages deliberately do not use this. Mannon's own interface is Mannon's
 * words; `BUYER_FACING_PATHS` is the list of what is not.
 */
export function ShopWording({
  locale,
  overrides,
  children,
}: {
  locale: Locale;
  overrides: Record<string, string>;
  children: React.ReactNode;
}) {
  const i18n = useMemo(() => createI18nSync(locale, overrides), [locale, overrides]);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

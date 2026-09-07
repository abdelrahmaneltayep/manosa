import { RemixBrowser } from "@remix-run/react";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { DEFAULT_LOCALE, normalizeLocale } from "~/i18n/config";
import { createI18n } from "~/i18n/i18next";

/**
 * i18next is initialised *before* hydration, from the `lang` the server already
 * put on <html>. Doing it after would hydrate English markup into an Arabic
 * tree and produce a hydration mismatch on every RTL page load.
 */
async function hydrate() {
  const locale = normalizeLocale(document.documentElement.lang) ?? DEFAULT_LOCALE;
  const i18n = await createI18n(locale);

  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <I18nextProvider i18n={i18n}>
          <RemixBrowser />
        </I18nextProvider>
      </StrictMode>,
    );
  });
}

if (window.requestIdleCallback) {
  window.requestIdleCallback(hydrate);
} else {
  window.setTimeout(hydrate, 1);
}

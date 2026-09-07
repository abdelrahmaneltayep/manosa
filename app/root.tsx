import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
  useRouteLoaderData,
} from "@remix-run/react";
import type { LinksFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useTranslation } from "react-i18next";

import { detectLocale } from "~/i18n.server";
import { DEFAULT_LOCALE, dirFor } from "~/i18n/config";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const locale = detectLocale(request);
  return json({
    // The public app key App Bridge reads from the meta tag below. Not a secret.
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    locale,
    dir: dirFor(locale),
  });
};

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const locale = data?.locale ?? DEFAULT_LOCALE;

  return (
    // lang/dir are set here rather than by a client effect so Arabic renders
    // mirrored on first paint. A layout that flips after hydration is a CLS
    // failure, and Built for Shopify measures it.
    <html lang={locale} dir={data?.dir ?? dirFor(DEFAULT_LOCALE)}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* App Bridge + Polaris web components. The meta tag must precede the
            script, and the script must not be deferred: App Bridge establishes
            the embedded session before the app renders. */}
        <meta name="shopify-api-key" content={data?.apiKey ?? ""} />
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const { t } = useTranslation();
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const key = notFound ? "error.notFound" : "error.generic";

  // The heading is a child element, not just the `heading` attribute: this
  // boundary also catches errors on unembedded routes, where App Bridge has
  // not upgraded the custom elements and attribute-only text would render as
  // nothing at all.
  return (
    <s-page heading={t(`${key}.heading`)}>
      <s-section>
        <s-banner tone="critical">
          <s-heading>{t(`${key}.heading`)}</s-heading>
          <s-paragraph>{t(`${key}.body`)}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

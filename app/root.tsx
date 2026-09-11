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

export const links: LinksFunction = () => [];

/**
 * Routes that are not the embedded admin.
 *
 * A buyer filling in a registration form on the merchant's storefront should
 * not be handed App Bridge: it cannot work outside the admin iframe, and it is
 * a third-party script on a page a member of the public is looking at.
 */
const PUBLIC_PREFIXES = ["/f/", "/q/"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const locale = detectLocale(request);
  const { pathname } = new URL(request.url);

  return json({
    // The public app key App Bridge reads from the meta tag below. Not a secret.
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    locale,
    dir: dirFor(locale),
    embedded: !PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)),
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
            the embedded session before the app renders. Left out entirely on
            the buyer-facing routes, which are not embedded and where it would
            be a third-party script loaded for nothing. */}
        {data?.embedded !== false ? (
          <>
            <link rel="preconnect" href="https://cdn.shopify.com" />
            <meta name="shopify-api-key" content={data?.apiKey ?? ""} />
            <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
          </>
        ) : null}
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

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
import type { LinksFunction } from "@remix-run/node";
import { json } from "@remix-run/node";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com" },
];

export const loader = async () => {
  // The public app key App Bridge reads from the meta tag below. Not a secret.
  return json({ apiKey: process.env.SHOPIFY_API_KEY ?? "" });
};

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");

  return (
    <html lang="en" dir="ltr">
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
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const notFound = status === 404;
  const heading = notFound ? "Page not found" : "Something went wrong";
  const detail = notFound
    ? "That page isn't part of Mannon. Use the app navigation to get back."
    : "Mannon couldn't load this page. Reload to try again — nothing was changed.";

  // The heading is a child element, not just the `heading` attribute: this
  // boundary also catches errors on unembedded routes, where App Bridge has
  // not upgraded the custom elements and attribute-only text would render as
  // nothing at all.
  return (
    <s-page heading={heading}>
      <s-section>
        <s-banner tone="critical">
          <s-heading>{heading}</s-heading>
          <s-paragraph>{detail}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

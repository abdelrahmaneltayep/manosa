import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { boundary } from "@shopify/shopify-app-remix/server";

import { ensureShopRecord } from "~/lib/shop/ensure-shop.server";
import { NAV_PAGES, navHref } from "~/lib/nav/pages";
import { withAdmin } from "~/shopify.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    await ensureShopRecord();
    return json({ shop: session.shop });
  });

export default function AppLayout() {
  const { shop } = useLoaderData<typeof loader>();

  return (
    <>
      {/* App Bridge renders this into the admin sidebar. The rel="home" link
          is hidden from the menu and sets the app's landing route. */}
      <s-app-nav>
        {NAV_PAGES.map((page) => (
          <Link
            key={page.i18nKey}
            to={navHref(page)}
            {...(page.path === "" ? { rel: "home" } : {})}
          >
            {page.defaultLabel}
          </Link>
        ))}
      </s-app-nav>
      <Outlet context={{ shop }} />
    </>
  );
}

/**
 * Shopify's boundary helpers re-throw embedded auth redirects (which must not
 * be swallowed) and render everything else through the root error boundary.
 */
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

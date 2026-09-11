import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { boundary } from "@shopify/shopify-app-remix/server";

import { useTranslation } from "react-i18next";

import { ensureShopRecord } from "~/lib/shop/ensure-shop.server";
import { NAV_PAGES, navHref, navLabelKey } from "~/lib/nav/pages";
import { withAdmin } from "~/shopify.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const record = await ensureShopRecord(admin);
    return json({
      shop: session.shop,
      paused: record?.pausedAt !== null && record?.pausedAt !== undefined,
    });
  });

export default function AppLayout() {
  const { shop, paused } = useLoaderData<typeof loader>();
  const { t } = useTranslation();

  return (
    <>
      {/* Every page, not only Settings.
          While paused, the Pricing list still badges every rule Active, the
          rule builder still previews "was $40 → now $28", and the quote
          builder prices at retail and **locks** those prices into the quote
          with no reason on screen. A merchant who paused and moved on had no
          signal anywhere that their trade prices were switched off. */}
      {paused ? (
        <s-banner tone="warning">
          <s-heading>{t("settings.danger.pausedHeading")}</s-heading>
          <s-paragraph>{t("settings.danger.pausedEverywhere")}</s-paragraph>
          <s-link href="/app/settings">{t("settings.danger.pausedSettingsLink")}</s-link>
        </s-banner>
      ) : null}
      {/* App Bridge renders this into the admin sidebar. The rel="home" link
          is hidden from the menu and sets the app's landing route. */}
      <s-app-nav>
        {NAV_PAGES.map((page) => (
          <Link
            key={page.key}
            to={navHref(page)}
            {...(page.path === "" ? { rel: "home" } : {})}
          >
            {t(navLabelKey(page))}
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

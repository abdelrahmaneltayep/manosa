import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useTranslation } from "react-i18next";

import { NAV_PAGES } from "~/lib/nav/pages";
import { withAdmin } from "~/shopify.server";

const PAGE = NAV_PAGES.find((page) => page.key === "analytics")!;

export const loader = ({ request }: LoaderFunctionArgs) =>
  // Authenticates the embedded request and opens the tenant scope. The page has
  // no data of its own yet; phase ${PAGE.phase} fills this in.
  withAdmin(request, async ({ session }) => json({ shop: session.shop }));

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const label = t(`nav.${PAGE.key}`);

  return (
    <s-page heading={label}>
      <s-section>
        <s-paragraph>{t(`page.${PAGE.key}.description`)}</s-paragraph>
      </s-section>
      <s-section heading={t("scaffold.heading")}>
        <s-banner tone="info">
          <s-heading>{t("scaffold.bannerHeading")}</s-heading>
          <s-paragraph>
            {t("scaffold.body", { feature: label, phase: PAGE.phase })}
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

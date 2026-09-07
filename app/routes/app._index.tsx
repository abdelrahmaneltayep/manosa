import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";

import { withAdmin } from "~/shopify.server";

export const meta: MetaFunction = () => [{ title: "Home · Mannon" }];

export const loader = ({ request }: LoaderFunctionArgs) =>
  // Authenticates the embedded request and opens the tenant scope. The page has
  // no data of its own yet; phase 4.5 fills this in.
  withAdmin(request, async ({ session }) => json({ shop: session.shop }));

export default function HomePage() {
  return (
    <s-page heading="Home">
      <s-section>
        <s-paragraph>
          Your wholesale command center — KPIs, the Merchant Agent briefing, and what
          needs you today.
        </s-paragraph>
      </s-section>
      <s-section heading="Not built yet">
        <s-banner tone="info" heading="Scaffold only">
          <s-paragraph>
            This page is a routing and layout placeholder from phase 0.1. The Home feature
            set lands in phase 4.5.
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

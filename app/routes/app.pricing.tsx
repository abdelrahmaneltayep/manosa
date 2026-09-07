import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";

import { withAdmin } from "~/shopify.server";

export const meta: MetaFunction = () => [{ title: "Pricing · Mannon" }];

export const loader = ({ request }: LoaderFunctionArgs) =>
  // Authenticates the embedded request and opens the tenant scope. The page has
  // no data of its own yet; phase 1.3 fills this in.
  withAdmin(request, async ({ session }) => json({ shop: session.shop }));

export default function PricingPage() {
  return (
    <s-page heading="Pricing">
      <s-section>
        <s-paragraph>
          Every price rule in one place: volume tiers, custom prices, discounts, priority
          and combinations.
        </s-paragraph>
      </s-section>
      <s-section heading="Not built yet">
        <s-banner tone="info" heading="Scaffold only">
          <s-paragraph>
            This page is a routing and layout placeholder from phase 0.1. The Pricing
            feature set lands in phase 1.3.
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

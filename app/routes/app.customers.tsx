import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";

import { withAdmin } from "~/shopify.server";

export const meta: MetaFunction = () => [{ title: "Customers · Mannon" }];

export const loader = ({ request }: LoaderFunctionArgs) =>
  // Authenticates the embedded request and opens the tenant scope. The page has
  // no data of its own yet; phase 2.1 fills this in.
  withAdmin(request, async ({ session }) => json({ shop: session.shop }));

export default function CustomersPage() {
  return (
    <s-page heading="Customers">
      <s-section>
        <s-paragraph>
          Approve wholesale applications, manage groups and tiers, and keep tags in sync.
        </s-paragraph>
      </s-section>
      <s-section heading="Not built yet">
        <s-banner tone="info" heading="Scaffold only">
          <s-paragraph>
            This page is a routing and layout placeholder from phase 0.1. The Customers
            feature set lands in phase 2.1.
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

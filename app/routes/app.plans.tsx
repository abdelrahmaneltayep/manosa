import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";

import { withAdmin } from "~/shopify.server";

export const meta: MetaFunction = () => [{ title: "Plans · Mannon" }];

export const loader = ({ request }: LoaderFunctionArgs) =>
  // Authenticates the embedded request and opens the tenant scope. The page has
  // no data of its own yet; phase 0.3 fills this in.
  withAdmin(request, async ({ session }) => json({ shop: session.shop }));

export default function PlansPage() {
  return (
    <s-page heading="Plans">
      <s-section>
        <s-paragraph>
          Your plan, what it includes, and an honest recommendation based on how you
          actually use Mannon.
        </s-paragraph>
      </s-section>
      <s-section heading="Not built yet">
        <s-banner tone="info" heading="Scaffold only">
          <s-paragraph>
            This page is a routing and layout placeholder from phase 0.1. The Plans
            feature set lands in phase 0.3.
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

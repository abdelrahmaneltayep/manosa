import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";

import { withAdmin } from "~/shopify.server";

export const meta: MetaFunction = () => [{ title: "Settings · Mannon" }];

export const loader = ({ request }: LoaderFunctionArgs) =>
  // Authenticates the embedded request and opens the tenant scope. The page has
  // no data of its own yet; phase 6.2 fills this in.
  withAdmin(request, async ({ session }) => json({ shop: session.shop }));

export default function SettingsPage() {
  return (
    <s-page heading="Settings">
      <s-section>
        <s-paragraph>
          Price display, discount combinations, notifications, translations, agent
          controls and the audit log.
        </s-paragraph>
      </s-section>
      <s-section heading="Not built yet">
        <s-banner tone="info" heading="Scaffold only">
          <s-paragraph>
            This page is a routing and layout placeholder from phase 0.1. The Settings
            feature set lands in phase 6.2.
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

import type { LoaderFunctionArgs } from "@remix-run/node";

import { authenticate } from "~/shopify.server";

/**
 * OAuth entry point and callback. `authenticate.admin` always throws here —
 * either a redirect into Shopify's consent screen or back into the app — so
 * this loader never returns.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

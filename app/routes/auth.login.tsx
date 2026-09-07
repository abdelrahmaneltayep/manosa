import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

import { login } from "~/shopify.server";

/**
 * Hands the shop domain to Shopify's login flow. Both verbs are supported so
 * the form on / can POST and Shopify's own redirects can GET.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return login(request);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return login(request);
};

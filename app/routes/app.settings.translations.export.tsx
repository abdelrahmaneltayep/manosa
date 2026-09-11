import type { LoaderFunctionArgs } from "@remix-run/node";

import { isSupportedLocale } from "~/i18n/config";
import { exportStrings } from "~/lib/i18n/fill.server";
import { withAdmin } from "~/shopify.server";

/** The shop's own wording, as a file they can keep or hand to a translator. */
export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const asked = new URL(request.url).searchParams.get("locale") ?? "";
    const locale = isSupportedLocale(asked) ? asked : "ar";

    return new Response(await exportStrings(locale), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="mannon-${session.shop}-${locale}.json"`,
        // A merchant's own copy, never a shared cache.
        "Cache-Control": "private, no-store",
      },
    });
  });

import type { LoaderFunctionArgs } from "@remix-run/node";

import { db } from "~/db.server";
import { recordAudit } from "~/lib/audit/record.server";
import { buyerData } from "~/lib/privacy/buyer-data.server";
import { withAdmin } from "~/shopify.server";

/**
 * Everything this app holds about one buyer, as a file.
 *
 * What `customers/data_request` is for. Shopify asks the app, the merchant
 * answers the person, and the merchant has thirty days — so "we hold nine
 * records, go and find them" is not an answer. The first version of the
 * handler wrote exactly that and pointed at the buyer page, which loads none
 * of the seven areas and does not exist at all for an applicant who never got
 * a Shopify account. This is the page that does.
 *
 * Downloading it is itself recorded: a merchant exporting one buyer's entire
 * history is a thing their own audit trail should show.
 */
export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customer");
    const submissionId = url.searchParams.get("submission");

    if (!customerId && !submissionId) {
      throw new Response("Name a customer or an application", { status: 400 });
    }

    // The address is read from the shop's own row rather than taken from the
    // query: a link is something anybody can edit, and this one hands back
    // everything held about whoever it names.
    const application = submissionId
      ? await db.formSubmission.findFirst({
          where: { id: submissionId },
          select: { email: true },
        })
      : null;
    const email = application?.email ?? null;

    if (!customerId && !email) throw new Response("Not found", { status: 404 });

    const held = await buyerData({ customerId, email });

    await recordAudit({
      actor: { type: "STAFF", id: session.id },
      action: "privacy.data_exported",
      summary: `Exported everything Mannon holds about one buyer, to answer their data request.`,
      subject: { type: "Shop", id: session.shop },
      // The shape, never the contents — the same rule the request entry keeps.
      metadata: Object.fromEntries(
        Object.entries(held).map(([area, rows]) => [area, rows.length]),
      ),
    });

    return new Response(
      `${JSON.stringify({ shop: session.shop, requestedFor: { customerId, email }, held }, null, 2)}\n`,
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="mannon-buyer-data.json"`,
          // One person's entire history. Never a shared cache, never stored.
          "Cache-Control": "private, no-store",
        },
      },
    );
  });

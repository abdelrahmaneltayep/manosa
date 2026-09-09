import type { LoaderFunctionArgs } from "@remix-run/node";

import { getUpload } from "~/lib/forms/submissions.server";
import { withAdmin } from "~/shopify.server";

/**
 * Download a file an applicant attached.
 *
 * Behind the admin session and the tenant scope, so a trade licence uploaded
 * to one store cannot be fetched by another — or by a stranger with the id.
 *
 * Served as an attachment with a fixed content type rather than the browser's
 * sniffed one: a file uploaded by a member of the public should never be
 * rendered inline in the merchant's admin origin.
 */
export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const upload = await getUpload(params.id!);
    if (!upload) throw new Response("File not found", { status: 404 });

    const safeName = upload.fileName.replace(/["\\\r\n]/g, "_");

    return new Response(Buffer.from(upload.content), {
      headers: {
        "Content-Type": upload.contentType,
        "Content-Length": String(upload.byteSize),
        "Content-Disposition": `attachment; filename="${safeName}"`,
        // Nothing has scanned this file, so nothing about it is trusted.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  });

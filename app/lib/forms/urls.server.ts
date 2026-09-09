/**
 * The public URL of a form.
 *
 * Built from the app's own origin rather than the shop's: the standalone page
 * is served by us, so a merchant copying this link gets one that works whether
 * or not their theme has the block.
 */
export function appOrigin(request: Request): string {
  const configured = process.env.SHOPIFY_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

export function publicUrlFor(request: Request, publicId: string): string {
  return `${appOrigin(request)}/f/${publicId}`;
}

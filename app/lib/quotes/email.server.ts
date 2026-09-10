import { formatMoney, money } from "@mannon/pricing-engine";
import type { Quote } from "@prisma/client";

import { deliverEmail } from "~/lib/email/deliver.server";
import { formatCurrency } from "~/lib/money";
import { appOrigin } from "~/lib/forms/urls.server";

/**
 * The two messages a quote sends.
 *
 * ✦ Drafting the wording is 4.x, with the rest of the AI layer. Until then
 * these ship, and they already carry what a buyer needs: the number, the total,
 * the date it runs out, and the link.
 */

export type QuoteEmailKind = "quote_sent" | "quote_expiring";

const TEMPLATES: Record<QuoteEmailKind, { subject: string; body: string }> = {
  quote_sent: {
    subject: "Your quote {{number}} from {{shopName}}",
    body: [
      "Hello {{company}},",
      "",
      "Here is the quote you asked for: {{total}} for {{lineCount}}.",
      "",
      "{{message}}",
      "",
      "It stands until {{expiresAt}}. Review and accept it here:",
      "{{link}}",
      "",
      "{{shopName}}",
    ].join("\n"),
  },
  quote_expiring: {
    subject: "Quote {{number}} runs out on {{expiresAt}}",
    body: [
      "Hello {{company}},",
      "",
      "Your quote {{number}} for {{total}} runs out on {{expiresAt}}.",
      "",
      "If you still want it, you can accept it here:",
      "{{link}}",
      "",
      "{{shopName}}",
    ].join("\n"),
  },
};

/**
 * The buyer's link.
 *
 * Built from the app's own origin, like a form's: we serve the page, so the
 * link works whether or not the merchant's theme has anything installed.
 */
export function quoteUrl(publicId: string, request?: Request): string {
  const origin = request
    ? appOrigin(request)
    : (process.env.SHOPIFY_APP_URL?.trim().replace(/\/+$/, "") ?? "");
  return `${origin}/q/${publicId}`;
}

export async function deliverQuoteEmail(
  quote: Quote & { lines: { quantity: number }[] },
  kind: QuoteEmailKind,
  shopName: string,
) {
  return deliverEmail({
    kind,
    to: quote.email ?? "",
    template: TEMPLATES[kind],
    values: {
      number: quote.number,
      company: quote.company ?? quote.email ?? "there",
      total: formatCurrency(money(quote.subtotal, quote.currencyCode)),
      lineCount: `${quote.lines.length} ${quote.lines.length === 1 ? "item" : "items"}`,
      message: quote.message ?? "",
      // The date, not a countdown: a buyer reading this in three days needs a
      // date that is still true.
      expiresAt: quote.expiresAt?.toISOString().slice(0, 10) ?? "",
      link: quoteUrl(quote.publicId),
      shopName,
    },
  });
}

/** Exported for the tests, and so the wording lives in one place. */
export { TEMPLATES as QUOTE_TEMPLATES, formatMoney };

import type { Shop } from "@prisma/client";

import type { SettingsIssueView, SettingsView } from "~/components/settings/types";
import { db } from "~/db.server";
import type { Translate } from "~/i18n/translate";
import { emailSender } from "~/lib/email/send.server";
import { formatCurrency } from "~/lib/money";
import { money } from "@mannon/pricing-engine";
import { shopScope } from "~/lib/tenant/shop-context.server";
import type { SettingsIssue, TaxDisplay } from "~/lib/settings/settings.server";

/**
 * Settings, and the consequences that belong beside them.
 *
 * Every count here answers a question a merchant would otherwise have to open
 * another page to answer — how many rules a combination change affects, how
 * many buyers carry the tag being renamed, how many quotes are already out
 * with dates this cannot move. The checklist asks for the first of those by
 * name (*"affects 3 active rules"*); the rest follow the same rule, because a
 * setting whose blast radius is invisible is one a merchant will not touch.
 */

/** The example product a storefront preview is built from. */
const SAMPLE = { retail: 4_000, wholesale: 2_800 };

function displayPreview(
  shop: Pick<Shop, "showCompareAt" | "taxDisplay" | "currencyCode">,
  locale: string,
  t: Translate,
) {
  const currencyCode = shop.currencyCode ?? "USD";
  const price = formatCurrency(money(SAMPLE.wholesale, currencyCode), locale);
  const compareAt = shop.showCompareAt
    ? formatCurrency(money(SAMPLE.retail, currencyCode), locale)
    : null;

  return {
    price,
    compareAt,
    // Display only — Shopify still decides what is charged, and saying
    // otherwise would be this app claiming a power it does not have.
    taxNote: t(`settings.display.taxNote.${shop.taxDisplay as TaxDisplay}`),
  };
}

/**
 * Which of the four sender states this shop is in.
 *
 * "Never checked" is not "unverified". The first is a statement about this
 * app, the second about the merchant's DNS, and showing the second when the
 * first is true is the page reporting a failure that never happened.
 */
function senderStatus(shop: Shop): "none" | "unchecked" | "failed" | "verified" {
  if (!shop.senderEmail) return "none";
  if (shop.senderVerifiedAt) return "verified";
  if (shop.senderCheckedAt) return "failed";
  return "unchecked";
}

function senderRecords(shop: Shop): { kind: string; host: string; value: string }[] {
  const raw = shop.senderDnsRecords;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    return typeof row.kind === "string" &&
      typeof row.host === "string" &&
      typeof row.value === "string"
      ? [{ kind: row.kind, host: row.host, value: row.value }]
      : [];
  });
}

export async function settingsView(options: {
  locale: string;
  t: Translate;
  saved?: string | null;
  failedSection?: string | null;
  issues?: SettingsIssue[];
  confirming?: boolean;
}): Promise<SettingsView> {
  const name = shopScope.require("settingsView");
  const { locale, t } = options;

  // The shop first: the tag it currently uses decides which buyers to count.
  const shop = await db.shop.findUniqueOrThrow({ where: { shop: name } });

  const [taggedBuyers, combinableRules, ruleCount, exemptWithoutVat, quotesOut] =
    await Promise.all([
      // Buyers carrying the tag today. Renaming it does not move them, which
      // is exactly what the copy beside the field has to say.
      db.customer.count({ where: { tags: { has: shop.wholesaleTag } } }),
      db.pricingRule.count({
        where: { status: "ACTIVE", archivedAt: null, combinable: true },
      }),
      db.pricingRule.count({ where: { status: "ACTIVE", archivedAt: null } }),
      db.customer.count({ where: { taxExempt: true, vatNumber: null } }),
      db.quote.count({ where: { status: "SENT" } }),
    ]);

  const issues: SettingsIssueView[] = (options.issues ?? []).map((issue) => ({
    field: issue.field,
    message: t(`settings.issue.${issue.field}.${issue.code}`),
  }));

  return {
    wholesale: {
      wholesaleTag: shop.wholesaleTag,
      wholesaleOrderTag: shop.wholesaleOrderTag,
      taggedBuyers,
    },
    display: {
      showCompareAt: shop.showCompareAt,
      hidePricesFromGuests: shop.hidePricesFromGuests,
      taxDisplay: shop.taxDisplay === "incl" ? "incl" : "excl",
      preview: displayPreview(shop, locale, t),
    },
    discounts: {
      allowShopifyDiscounts: shop.allowShopifyDiscounts,
      combinableRules,
      // The count is only half of "shows its working" — the rules themselves
      // have to be one click away, or a merchant is trusting a number.
      combinableHref: "/app/pricing?combinable=1",
    },
    tax: {
      requireVatForTaxExempt: shop.requireVatForTaxExempt,
      taxExemptNeedsApproval: shop.taxExemptNeedsApproval,
      exemptWithoutVat,
    },
    orders: {
      posBypassesLimits: shop.posBypassesLimits,
      quoteExpiryDays: shop.quoteExpiryDays,
      quoteReminderDays: shop.quoteReminderDays,
      quotesOutstanding: quotesOut,
    },
    sender: {
      senderEmail: shop.senderEmail ?? "",
      senderDomain: shop.senderDomain,
      status: senderStatus(shop),
      checkedAt: shop.senderCheckedAt?.toISOString() ?? null,
      error: shop.senderCheckError,
      records: senderRecords(shop),
      // What mail actually goes out as until the merchant's own domain is
      // verified. Null means nothing can be sent at all, which the page says.
      fallbackFrom: emailSender(),
      // With no provider wired up, "Verify" would be a button that checks
      // nothing and reports success. It is disabled and says why instead.
      verifiable: emailSender() !== null,
    },
    danger: {
      paused: shop.pausedAt !== null,
      pausedAt: shop.pausedAt?.toISOString() ?? null,
      ruleCount,
      confirming: options.confirming ?? false,
    },
    saved: options.saved ?? null,
    failedSection: options.failedSection ?? null,
    issues,
  };
}

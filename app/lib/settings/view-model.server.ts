import type { Shop } from "@prisma/client";

import type {
  DisplaySettingsView,
  SettingsIssueView,
  SettingsView,
} from "~/components/settings/types";
import { db } from "~/db.server";
import type { Translate } from "~/i18n/translate";
import { emailSender } from "~/lib/email/send.server";
import { isAiAvailable } from "~/lib/ai/client.server";
import { AUDIT_RETENTION_DAYS } from "~/lib/jobs/handlers/purge-audit.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { SAMPLES_WANTED, listSamples } from "~/lib/settings/brand-voice.server";
import { previewFor } from "~/lib/pricing/view-model.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import type { SettingsIssue } from "~/lib/settings/settings.server";

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

/**
 * What a buyer will read, priced by the engine.
 *
 * The first version of this hardcoded `{ retail: 4000, wholesale: 2800 }` — a
 * 30% discount that came from no rule of this merchant's and never went near
 * `resolvePrice` — and labelled it "A buyer will read:". Invariant 1 is
 * absolute about that, and Invariant 4 about the label: it was still shown,
 * unchanged, on a shop that was **paused**, where no buyer was getting a
 * wholesale price anywhere.
 *
 * Now it runs the shop's own highest-priority active rule through the engine,
 * says it is an example, and is blank when there is nothing to show — no
 * rules, or the app paused.
 */
async function displayPreview(
  shop: Shop,
  locale: string,
  t: Translate,
  now: Date,
): Promise<DisplaySettingsView["preview"]> {
  const currencyCode = shop.currencyCode ?? "USD";
  const taxNote = t(
    `settings.display.taxNote.${shop.taxDisplay === "incl" ? "incl" : "excl"}`,
  );

  // `activeEngineRules` already returns nothing while paused, so a paused shop
  // falls through to the empty preview without a second check.
  const { rules } = await activeEngineRules();
  const rule = rules[0];
  if (!rule) return { price: null, compareAt: null, taxNote };

  const priced = previewFor(rule, currencyCode, now);
  if (priced.unavailable || !priced.changed) {
    return { price: null, compareAt: null, taxNote };
  }

  return {
    price: priced.now,
    compareAt: shop.showCompareAt ? priced.was : null,
    taxNote,
    ruleName: rule.name,
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

/** The spellings a stored tag could be held under. */
const tagVariants = (tag: string): string[] => [
  ...new Set([tag, tag.toLowerCase(), tag.toUpperCase()]),
];

export async function settingsView(options: {
  locale: string;
  t: Translate;
  now?: Date;
  saved?: string | null;
  failedSection?: string | null;
  issues?: SettingsIssue[];
  confirming?: boolean;
  /**
   * The body that failed to save, echoed back into its fields.
   *
   * Without it the 422 branch rebuilt every field from the **stored** row, so
   * a merchant who typed `trade,vip` saw the error message under a field
   * reading `wholesale` — with nothing to fix and no way to tell which of two
   * tag fields was at fault. A multi-field section lost every edit in it.
   */
  echo?: FormData | null;
}): Promise<SettingsView> {
  const name = shopScope.require("settingsView");
  const { locale, t } = options;

  // The shop first: the tag it currently uses decides which buyers to count.
  const shop = await db.shop.findUniqueOrThrow({ where: { shop: name } });

  const [taggedBuyers, combinableRules, ruleCount, exemptWithoutVat, quotesOut, samples] =
    await Promise.all([
      // Buyers carrying the tag today. Renaming it does not move them, which
      // is exactly what the copy beside the field has to say.
      //
      // Case-insensitively, like every other tag comparison in this app
      // (`tagging.ts`, `sync.server.ts`, the pricing engine's eligibility).
      // Matching exactly meant a shop whose tag is "Wholesale" and whose
      // buyers are tagged "wholesale" was told **nobody** would be affected by
      // a rename, while the engine priced every one of them as wholesale.
      db.customer.count({
        where: { tags: { hasSome: tagVariants(shop.wholesaleTag) } },
      }),
      db.pricingRule.count({
        where: { status: "ACTIVE", archivedAt: null, combinable: true },
      }),
      db.pricingRule.count({ where: { status: "ACTIVE", archivedAt: null } }),
      db.customer.count({ where: { taxExempt: true, vatNumber: null } }),
      db.quote.count({ where: { status: "SENT" } }),
      listSamples(),
    ]);

  const typed = (key: string, fallback: string): string => {
    const value = options.echo?.get(key);
    return typeof value === "string" ? value : fallback;
  };
  const ticked = (key: string, fallback: boolean): boolean =>
    options.echo ? options.echo.get(key) !== null : fallback;

  const issues: SettingsIssueView[] = (options.issues ?? []).map((issue) => ({
    field: issue.field,
    message: t(`settings.issue.${issue.field}.${issue.code}`),
  }));

  return {
    wholesale: {
      wholesaleTag: typed("wholesaleTag", shop.wholesaleTag),
      wholesaleOrderTag: typed("wholesaleOrderTag", shop.wholesaleOrderTag),
      taggedBuyers,
    },
    display: {
      showCompareAt: ticked("showCompareAt", shop.showCompareAt),
      hidePricesFromGuests: ticked("hidePricesFromGuests", shop.hidePricesFromGuests),
      taxDisplay: typed("taxDisplay", shop.taxDisplay) === "incl" ? "incl" : "excl",
      preview: await displayPreview(shop, locale, t, options.now ?? new Date()),
    },
    discounts: {
      allowShopifyDiscounts: ticked("allowShopifyDiscounts", shop.allowShopifyDiscounts),
      combinableRules,
      // The count is only half of "shows its working" — the rules themselves
      // have to be one click away, or a merchant is trusting a number.
      combinableHref: "/app/pricing?combinable=1",
    },
    tax: {
      requireVatForTaxExempt: ticked(
        "requireVatForTaxExempt",
        shop.requireVatForTaxExempt,
      ),
      exemptWithoutVat,
    },
    orders: {
      posBypassesLimits: ticked("posBypassesLimits", shop.posBypassesLimits),
      quoteExpiryDays: Number(typed("quoteExpiryDays", String(shop.quoteExpiryDays))),
      quoteReminderDays: Number(
        typed("quoteReminderDays", String(shop.quoteReminderDays)),
      ),
      quotesOutstanding: quotesOut,
    },
    agent: {
      mayScreen: shop.aiMayScreen,
      mayDraft: shop.aiMayDraft,
      // With no key the toggles decide nothing, and the card says so rather
      // than letting a merchant switch something that was never on.
      noKey: !isAiAvailable(),
      samples: samples.map((sample) => ({
        id: sample.id,
        label: sample.label,
        body: sample.body,
        added: sample.createdAt.toISOString().slice(0, 10),
      })),
      samplesWanted: SAMPLES_WANTED,
      // Muted from the home page and, until now, readable nowhere — so a
      // merchant who silenced a kind of briefing item could never find it
      // again to change their mind.
      mutedBriefings: [...new Set(shop.briefingMuted)].map((kind) => ({
        kind,
        label: t(`settings.agent.briefingKind.${kind}`),
      })),
      auditHref: "/app/activity",
      retentionDays: AUDIT_RETENTION_DAYS,
    },
    sender: {
      senderEmail: typed("senderEmail", shop.senderEmail ?? ""),
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
      // Paused here, but the empty ruleset never reached Shopify — the publish
      // failed part-way. Until it lands, checkout is still discounting, and
      // the banner must not say "no wholesale price is being applied
      // anywhere" about a shop where one still is.
      reachedCheckout: shop.pausedAt === null || shop.pausePublishedAt !== null,
    },
    saved: options.saved ?? null,
    failedSection: options.failedSection ?? null,
    issues,
  };
}

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The settings a merchant owns, in one place.
 *
 * Most of these existed as columns with a default and nothing to change them:
 * `requireVatForTaxExempt`, `wholesaleOrderTag`, `quoteExpiryDays` and
 * `quoteReminderDays` were written by no code path in the app, and
 * `wholesaleTag` only by the setup wizard. A default a merchant cannot change
 * is a decision this app made for them and did not tell them about.
 *
 * Saved a **section at a time**, because each section is its own card with its
 * own save bar. A form posts only its own fields, so one section's validation
 * error cannot discard another section's unsaved work.
 */

export const SECTIONS = [
  "wholesale",
  "display",
  "discounts",
  "tax",
  "orders",
  "agent",
  "notifications",
] as const;
export type SettingsSection = (typeof SECTIONS)[number];

export const isSection = (value: string): value is SettingsSection =>
  (SECTIONS as readonly string[]).includes(value);

export const TAX_DISPLAYS = ["excl", "incl"] as const;
export type TaxDisplay = (typeof TAX_DISPLAYS)[number];

/** A field that could not be saved, and why, in the merchant's own words. */
export interface SettingsIssue {
  field: string;
  code: string;
}

export class SettingsInvalid extends Error {
  constructor(readonly issues: SettingsIssue[]) {
    super(`${issues.length} setting(s) could not be saved`);
    this.name = "SettingsInvalid";
  }
}

/* -------------------------------------------------------------------------- */

/** A Shopify customer tag: no commas, and something has to be left. */
function readTag(value: string, field: string, issues: SettingsIssue[]): string {
  const tag = value.trim();
  if (tag === "") issues.push({ field, code: "required" });
  // Shopify splits tags on commas, so a comma here silently becomes two tags
  // and neither is the one the merchant typed.
  else if (tag.includes(",")) issues.push({ field, code: "comma" });
  else if (tag.length > 40) issues.push({ field, code: "tooLong" });
  return tag;
}

function readDays(
  value: string,
  field: string,
  bounds: { min: number; max: number },
  issues: SettingsIssue[],
): number {
  const text = value.trim();
  // `Number("0x10")` is 16, so a reminder typed as "0x10" stored 16 days.
  // Plain digits only: this is a day count a merchant typed into a number
  // field, not an expression.
  const days = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(days) || days < bounds.min || days > bounds.max) {
    issues.push({ field, code: "range" });
    return bounds.min;
  }
  return days;
}

/**
 * An address, loosely.
 *
 * Deliberately not a full RFC 5322 check: the only thing this app can actually
 * verify about a sender address is whether mail through it is accepted, and it
 * says so rather than implying a green tick means delivery works.
 */
const LOOKS_LIKE_EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/* -------------------------------------------------------------------------- */

export interface SaveContext {
  actor: AuditActor;
  now?: Date;
}

export async function saveSettings(
  section: SettingsSection,
  form: FormData,
  { actor, now = new Date() }: SaveContext,
): Promise<void> {
  const shop = shopScope.require("saveSettings");
  const issues: SettingsIssue[] = [];
  const text = (key: string) => (form.get(key) ?? "").toString();
  // Presence, not the string "on". An unchecked box posts nothing at all; a
  // checked one posts whatever its `value` is, and Polaris documents no
  // default for `s-checkbox`. Comparing to "on" meant that if the upgraded
  // component submits anything else, every checkbox in Settings would save as
  // *off* and render unticked afterwards — which reads as data loss, not as a
  // bug. `app/routes/app.orders.limits.tsx` already tests presence; this now
  // matches it, and every checkbox carries an explicit value="on" besides.
  const on = (key: string) => form.get(key) !== null;

  const data = (() => {
    switch (section) {
      case "wholesale":
        return {
          wholesaleTag: readTag(text("wholesaleTag"), "wholesaleTag", issues),
          wholesaleOrderTag: readTag(
            text("wholesaleOrderTag"),
            "wholesaleOrderTag",
            issues,
          ),
        };

      case "display": {
        const taxDisplay = text("taxDisplay").trim();
        if (!(TAX_DISPLAYS as readonly string[]).includes(taxDisplay)) {
          issues.push({ field: "taxDisplay", code: "choice" });
        }
        return {
          showCompareAt: on("showCompareAt"),
          hidePricesFromGuests: on("hidePricesFromGuests"),
          taxDisplay: taxDisplay as TaxDisplay,
        };
      }

      case "discounts":
        return { allowShopifyDiscounts: on("allowShopifyDiscounts") };

      case "agent":
        return { aiMayScreen: on("aiMayScreen"), aiMayDraft: on("aiMayDraft") };

      case "tax":
        return { requireVatForTaxExempt: on("requireVatForTaxExempt") };

      case "orders": {
        const expiry = readDays(
          text("quoteExpiryDays"),
          "quoteExpiryDays",
          { min: 1, max: 365 },
          issues,
        );
        const reminder = readDays(
          text("quoteReminderDays"),
          "quoteReminderDays",
          { min: 1, max: 364 },
          issues,
        );
        // A reminder after the quote has expired is a reminder nobody gets.
        if (reminder >= expiry) {
          issues.push({ field: "quoteReminderDays", code: "afterExpiry" });
        }
        return {
          posBypassesLimits: on("posBypassesLimits"),
          quoteExpiryDays: expiry,
          quoteReminderDays: reminder,
        };
      }

      case "notifications": {
        const email = text("senderEmail").trim();
        if (email !== "" && !LOOKS_LIKE_EMAIL.test(email)) {
          issues.push({ field: "senderEmail", code: "email" });
        }
        const domain = email.split("@")[1] ?? null;
        return {
          senderEmail: email === "" ? null : email,
          senderDomain: domain,
        };
      }
    }
  })();

  if (issues.length > 0) throw new SettingsInvalid(issues);

  const before = await db.shop.findUnique({ where: { shop } });
  const changed = Object.entries(data).filter(
    ([key, value]) => (before as Record<string, unknown> | null)?.[key] !== value,
  );
  // `senderDomain` is derived from `senderEmail`, so counting it made a
  // one-field edit read as "Changed 2 notifications settings".
  const reported = changed.filter(([key]) => key !== "senderDomain");

  // Nothing to write is not an error, but it is also not an audit entry — a log
  // full of "changed nothing" entries is a log nobody reads.
  if (changed.length === 0) return;

  // Changing the sender address un-verifies it. A domain verified for one
  // address is not proof of another, and carrying the tick across would be the
  // page claiming a check that never ran.
  const extra =
    section === "notifications" &&
    changed.some(([key]) => key === "senderEmail" || key === "senderDomain")
      ? { senderVerifiedAt: null, senderCheckedAt: null, senderCheckError: null }
      : {};

  await db.shop.update({ where: { shop }, data: { ...data, ...extra } });

  await recordAudit({
    actor,
    action: `settings.${section}_updated`,
    summary: summaryFor(section, Math.max(1, reported.length)),
    subject: { type: "Shop", id: shop },
    metadata: { section, changed: changed.map(([key]) => key), at: now.toISOString() },
  });
}

const summaryFor = (section: SettingsSection, count: number) =>
  `Changed ${count} ${section} setting${count === 1 ? "" : "s"}.`;

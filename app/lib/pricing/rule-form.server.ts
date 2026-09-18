import {
  parseMoney,
  validateRule,
  type Audience,
  type MarketScope,
  type PricingRule,
  type RuleIssue,
  type Targeting,
  type VolumeTier,
} from "@mannon/pricing-engine";

import { dayEnd, dayStart } from "~/lib/analytics/series.server";

/**
 * Form data → an engine rule.
 *
 * Parsing and validating are separate steps on purpose: a half-typed form
 * should come back with field-level errors, not a thrown parse failure, so the
 * merchant keeps what they wrote.
 */

export interface ParsedRuleForm {
  rule: PricingRule;
  issues: RuleIssue[];
  /** Version the editor loaded, for the concurrency check. */
  version: number;
  /** Fields the parser could not read at all, keyed by field path. */
  unreadable: RuleIssue[];
}

const asString = (form: FormData, key: string) => (form.get(key) ?? "").toString().trim();

const asList = (form: FormData, key: string) =>
  asString(form, key)
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const asNumber = (form: FormData, key: string, fallback: number) => {
  const raw = asString(form, key);
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
};

/**
 * A `YYYY-MM-DD` from an `s-date-field`, as the instant the merchant meant.
 *
 * The builder's schedule fields are day granularity, so "starts 1 July" means
 * the first instant of 1 July **in the shop's own timezone**, and "ends 1 July"
 * means the last instant of it. Both halves were wrong: `new Date("2026-07-01")`
 * is UTC midnight, so a rule set to end on 1 July was dead for the whole of the
 * day it named, and in a US-Pacific store a rule starting "1 July" went live at
 * 18:00 on 30 June, store time. The shop's `ianaTimezone` was populated and
 * respected by every analytics surface, and by nothing here.
 */
const asDay = (
  form: FormData,
  key: string,
  timeZone: string | null,
  edge: "start" | "end",
  unreadable: RuleIssue[],
): Date | null => {
  const raw = asString(form, key);
  if (!raw) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // Anything that is not a plain day is taken at face value, so a value set
    // by an import or an API still parses.
    const exact = new Date(raw);
    if (!Number.isNaN(exact.getTime())) return exact;

    // And a date nothing can read is said out loud. Returning null quietly
    // meant a merchant who typed "31/12/2026" saved a rule with **no end date
    // at all** and was told nothing — a rule they believed was scheduled,
    // running for ever.
    unreadable.push({ code: "date_unreadable", field: `schedule.${key}` });
    return null;
  }

  return edge === "start" ? dayStart(raw, timeZone) : dayEnd(raw, timeZone);
};

/**
 * The rule's amount in currencies other than the shop's own.
 *
 * `CurrencyAmount.overrides` has been in the model since 1.1 and every
 * production writer set `{}`, so in a store selling in more than one currency
 * `amountInCurrency` returned null for every `fixed_price` and `amount_off`
 * rule outside the home currency and the rule was skipped with
 * `no_price_in_currency`. Percentage rules still applied — so a buyer checking
 * out in EUR lost exactly their **negotiated contract prices** and kept the
 * percentage discounts, and there was no field anywhere to fix it.
 *
 * Entered by hand rather than enumerated from Shopify Markets: the engine
 * refuses to invent an exchange rate (`resolve.ts`), and so should the form —
 * a converted figure a merchant did not type is a price nothing else in the
 * system agrees with.
 */
function parseOverrides(
  form: FormData,
  homeCurrency: string,
  unreadable: RuleIssue[],
): Record<string, ReturnType<typeof parseMoney>> {
  const currencies = form.getAll("overrideCurrency").map((one) => one.toString());
  const amounts = form.getAll("overrideAmount").map((one) => one.toString());
  const overrides: Record<string, ReturnType<typeof parseMoney>> = {};

  for (const [index, raw] of currencies.entries()) {
    const currency = raw.trim().toUpperCase();
    const amount = (amounts[index] ?? "").trim();

    // A blank row is a row the merchant has not filled in, not an error.
    if (!currency && !amount) continue;

    if (!/^[A-Z]{3}$/.test(currency)) {
      unreadable.push({
        code: "currency_unknown",
        field: `value.overrides.${index}`,
        params: { currency: raw },
      });
      continue;
    }

    // The home currency is `base`. Two answers for one currency is a rule
    // whose price depends on which one is read first.
    if (currency === homeCurrency.toUpperCase()) {
      unreadable.push({
        code: "currency_duplicate",
        field: `value.overrides.${index}`,
        params: { currency },
      });
      continue;
    }

    try {
      overrides[currency] = parseMoney(amount || "0", currency);
    } catch {
      unreadable.push({
        code: "amount_negative",
        field: `value.overrides.${index}`,
        params: { amount },
      });
    }
  }

  return overrides;
}

function parseTargets(form: FormData): Targeting {
  const mode = (asString(form, "targetMode") || "all") as Targeting["mode"];

  return {
    mode,
    collectionIds: asList(form, "targetCollectionIds"),
    productIds: asList(form, "targetProductIds"),
    variantIds: asList(form, "targetVariantIds"),
    excludeCollectionIds: asList(form, "excludeCollectionIds"),
    excludeProductIds: asList(form, "excludeProductIds"),
    excludeVariantIds: asList(form, "excludeVariantIds"),
  };
}

function parseAudience(form: FormData): Audience {
  const mode = (asString(form, "audienceMode") || "all") as Audience["mode"];

  return {
    mode,
    tags: asList(form, "audienceTags"),
    groupIds: asList(form, "audienceGroupIds"),
    customerIds: asList(form, "audienceCustomerIds"),
    companyIds: asList(form, "audienceCompanyIds"),
  };
}

/**
 * Market scoping, which this product does not have yet.
 *
 * `MarketScope` is in the engine and three golden vectors exercise it, but the
 * checkout Function cannot evaluate one: it knows the buyer's **country**, not
 * which Shopify Market that maps to — `Localization.market` is deprecated and
 * the mapping is per-shop. So a market-scoped rule is dropped at checkout
 * while the admin shows it applying, which is the disagreement this whole app
 * exists to prevent.
 *
 * The builder has no market fields, so nothing reaches here in practice. This
 * refuses a scope posted by hand for the same reason: better no feature than a
 * field that quietly does nothing. When the country-to-market map is published
 * to the Function, this is where the gate comes off — and
 * `tests/unit/market-scoping.test.ts` is the reminder.
 */
function parseMarkets(_form: FormData): MarketScope {
  return { mode: "all", marketIds: [] };
}

/** Tiers arrive as parallel arrays: tierMin[], tierMax[], tierKind[], tierValue[]. */
function parseTiers(
  form: FormData,
  currencyCode: string,
  unreadable: RuleIssue[],
): VolumeTier[] {
  const mins = form.getAll("tierMin").map((value) => value.toString().trim());
  const maxes = form.getAll("tierMax").map((value) => value.toString().trim());
  const kinds = form.getAll("tierKind").map((value) => value.toString().trim());
  const values = form.getAll("tierValue").map((value) => value.toString().trim());

  const tiers: VolumeTier[] = [];

  for (let index = 0; index < mins.length; index += 1) {
    // A blank row is a row the merchant has not filled in yet, not an error.
    if (!mins[index] && !values[index]) continue;

    const field = `value.tiers.${index}`;
    const minQuantity = Number(mins[index]);
    const maxRaw = maxes[index] ?? "";
    const maxQuantity = maxRaw === "" ? null : Number(maxRaw);
    const kind = kinds[index] ?? "percentage";

    if (!Number.isFinite(minQuantity)) {
      unreadable.push({
        code: "tier_quantity_invalid",
        field: `${field}.minQuantity`,
        params: { minQuantity: mins[index] ?? "" },
      });
      continue;
    }

    if (kind === "percentage") {
      tiers.push({
        minQuantity,
        maxQuantity,
        kind: "percentage",
        percentage: Number(values[index]),
      });
      continue;
    }

    try {
      const amount = parseMoney(values[index] || "0", currencyCode);
      tiers.push(
        kind === "fixed_price"
          ? { minQuantity, maxQuantity, kind: "fixed_price", amount }
          : { minQuantity, maxQuantity, kind: "amount_off", amount },
      );
    } catch {
      unreadable.push({
        code: "amount_negative",
        field: `${field}.amount`,
        params: { amount: values[index] ?? "" },
      });
    }
  }

  return tiers;
}

export function parseRuleForm(
  form: FormData,
  options: {
    id?: string;
    currencyCode: string;
    createdAt?: Date;
    /** The shop's own zone. Null falls back to UTC, as every other surface does. */
    timeZone?: string | null;
  },
): ParsedRuleForm {
  const unreadable: RuleIssue[] = [];
  const currencyCode = options.currencyCode;
  const kind = (asString(form, "kind") || "percentage") as PricingRule["kind"];

  const base = {
    id: options.id ?? "new",
    name: asString(form, "name"),
    status: (asString(form, "status") || "draft") as PricingRule["status"],
    priority: asNumber(form, "priority", 100),
    combinable: asString(form, "combinable") === "on",
    targets: parseTargets(form),
    audience: parseAudience(form),
    markets: parseMarkets(form),
    schedule: {
      startsAt: asDay(form, "startsAt", options.timeZone ?? null, "start", unreadable),
      endsAt: asDay(form, "endsAt", options.timeZone ?? null, "end", unreadable),
    },
    createdAt: options.createdAt ?? new Date(),
  };

  let rule: PricingRule;

  switch (kind) {
    case "volume_tier":
      rule = {
        ...base,
        kind: "volume_tier",
        value: { tiers: parseTiers(form, currencyCode, unreadable) },
      };
      break;

    case "fixed_price":
    case "amount_off": {
      let amount;
      try {
        amount = parseMoney(asString(form, "amount") || "0", currencyCode);
      } catch {
        unreadable.push({
          code: "amount_negative",
          field: "value.base",
          params: { amount: asString(form, "amount") },
        });
        amount = parseMoney("0", currencyCode);
      }
      rule = {
        ...base,
        kind,
        value: {
          base: amount,
          overrides: parseOverrides(form, currencyCode, unreadable),
        },
      };
      break;
    }

    case "cart_value_tier": {
      // The builder offers one threshold; more than one is rare enough that a
      // repeatable row would cost more than it earns until someone asks.
      let minSubtotal;
      try {
        minSubtotal = parseMoney(asString(form, "cartMinimum") || "0", currencyCode);
      } catch {
        unreadable.push({ code: "amount_negative", field: "value.tiers.0.minSubtotal" });
        minSubtotal = parseMoney("0", currencyCode);
      }
      rule = {
        ...base,
        kind: "cart_value_tier",
        value: {
          tiers: [
            {
              minSubtotal,
              maxSubtotal: null,
              kind: "percentage",
              percentage: asNumber(form, "percentage", 0),
            },
          ],
        },
      };
      break;
    }

    case "percentage":
    default:
      rule = {
        ...base,
        kind: "percentage",
        value: { percentage: asNumber(form, "percentage", Number.NaN) },
      };
      break;
  }

  return {
    rule,
    issues: [...unreadable, ...validateRule(rule)],
    version: asNumber(form, "version", 1),
    unreadable,
  };
}

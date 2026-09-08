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

const asDate = (form: FormData, key: string): Date | null => {
  const raw = asString(form, key);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

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

function parseMarkets(form: FormData): MarketScope {
  const mode = (asString(form, "marketMode") || "all") as MarketScope["mode"];
  return { mode, marketIds: asList(form, "marketIds") };
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
  options: { id?: string; currencyCode: string; createdAt?: Date },
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
    schedule: { startsAt: asDate(form, "startsAt"), endsAt: asDate(form, "endsAt") },
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
      rule = { ...base, kind, value: { base: amount, overrides: {} } };
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

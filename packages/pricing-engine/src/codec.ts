import { money, type Money } from "./money";
import type {
  Audience,
  CartValueTier,
  CurrencyAmount,
  MarketScope,
  PricingRule,
  RuleKind,
  RuleStatus,
  Targeting,
  VolumeTier,
} from "./types";

/**
 * The wire format for a ruleset.
 *
 * The app writes it to a Shopify metafield; the discount Function reads it back
 * at checkout. Both sides use this module, so there is one definition of the
 * format rather than two that drift.
 *
 * `Date` has no JSON representation, so times are ISO strings on the wire.
 * Everything else is already JSON-safe: money is `{ amount, currencyCode }`
 * with an integer amount.
 */

export const RULESET_FORMAT_VERSION = 1;

export interface SerializedRuleset {
  v: number;
  rules: SerializedRule[];
}

export interface SerializedRule {
  id: string;
  name: string;
  status: RuleStatus;
  priority: number;
  combinable: boolean;
  kind: RuleKind;
  value: unknown;
  targets: Targeting;
  audience: Audience;
  markets: MarketScope;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
}

function serializeValue(rule: PricingRule): unknown {
  switch (rule.kind) {
    case "percentage":
      return { percentage: rule.value.percentage };
    case "fixed_price":
    case "amount_off":
      return { base: rule.value.base, overrides: rule.value.overrides };
    case "volume_tier":
      return { tiers: rule.value.tiers };
    case "cart_value_tier":
      return { tiers: rule.value.tiers };
  }
}

export function serializeRule(rule: PricingRule): SerializedRule {
  return {
    id: rule.id,
    name: rule.name,
    status: rule.status,
    priority: rule.priority,
    combinable: rule.combinable,
    kind: rule.kind,
    value: serializeValue(rule),
    targets: rule.targets,
    audience: rule.audience,
    markets: rule.markets,
    startsAt: rule.schedule.startsAt ? rule.schedule.startsAt.toISOString() : null,
    endsAt: rule.schedule.endsAt ? rule.schedule.endsAt.toISOString() : null,
    createdAt: rule.createdAt.toISOString(),
  };
}

export function serializeRuleset(rules: PricingRule[]): SerializedRuleset {
  return { v: RULESET_FORMAT_VERSION, rules: rules.map(serializeRule) };
}

/* -------------------------------------------------------------------------- */
/* Reading it back                                                             */
/* -------------------------------------------------------------------------- */

export interface DeserializeResult {
  rules: PricingRule[];
  /** Rules that could not be read, and why. Never thrown. */
  errors: { ruleId: string | null; message: string }[];
}

/**
 * Parsing is deliberately defensive and never throws.
 *
 * A discount Function that crashes applies no discounts at all, so every
 * wholesale buyer in that store is charged retail until someone notices. One
 * malformed rule must cost that rule, not the whole cart.
 */
export function deserializeRuleset(value: unknown): DeserializeResult {
  const errors: DeserializeResult["errors"] = [];

  if (value === null || value === undefined) return { rules: [], errors };

  // A metafield may hand back a JSON string rather than a parsed object.
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {
        rules: [],
        errors: [{ ruleId: null, message: "ruleset is not valid JSON" }],
      };
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { rules: [], errors: [{ ruleId: null, message: "ruleset is not an object" }] };
  }

  const envelope = parsed as Partial<SerializedRuleset>;

  if (envelope.v !== RULESET_FORMAT_VERSION) {
    // A newer format from a newer app version. Refusing is right: guessing at
    // fields we do not understand could mean charging the wrong price.
    return {
      rules: [],
      errors: [
        {
          ruleId: null,
          message: `ruleset format v${String(envelope.v)} is not v${RULESET_FORMAT_VERSION}`,
        },
      ],
    };
  }

  if (!Array.isArray(envelope.rules)) {
    return {
      rules: [],
      errors: [{ ruleId: null, message: "ruleset has no rules array" }],
    };
  }

  const rules: PricingRule[] = [];

  for (const raw of envelope.rules) {
    const result = readRule(raw);
    if ("rule" in result) rules.push(result.rule);
    else errors.push(result.error);
  }

  return { rules, errors };
}

type ReadResult =
  { rule: PricingRule } | { error: { ruleId: string | null; message: string } };

/**
 * Read one serialized rule.
 *
 * The app uses this to turn a database row into an engine rule, so storage and
 * the ruleset published to checkout go through exactly the same code.
 */
export function deserializeRule(raw: unknown): ReadResult {
  return readRule(raw);
}

function isMoney(value: unknown): value is Money {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as Money).amount) &&
    typeof (value as Money).currencyCode === "string"
  );
}

function readMoney(value: unknown, label: string): Money {
  if (!isMoney(value)) throw new Error(`${label} is not a money value`);
  return money((value as Money).amount, (value as Money).currencyCode);
}

function readCurrencyAmount(value: unknown, label: string): CurrencyAmount {
  const raw = value as { base?: unknown; overrides?: unknown };
  const base = readMoney(raw?.base, `${label}.base`);
  const overrides: Record<string, Money> = {};

  for (const [code, amount] of Object.entries(
    (raw?.overrides ?? {}) as Record<string, unknown>,
  )) {
    overrides[code] = readMoney(amount, `${label}.overrides.${code}`);
  }

  return { base, overrides };
}

function readVolumeTiers(value: unknown): VolumeTier[] {
  const raw = (value as { tiers?: unknown })?.tiers;
  if (!Array.isArray(raw)) throw new Error("volume tiers missing");

  return raw.map((entry, index) => {
    const tier = entry as Record<string, unknown>;
    const bounds = {
      minQuantity: Number(tier.minQuantity),
      maxQuantity: tier.maxQuantity === null ? null : Number(tier.maxQuantity),
    };

    if (!Number.isSafeInteger(bounds.minQuantity)) {
      throw new Error(`tier ${index} has no minQuantity`);
    }

    if (tier.kind === "percentage") {
      return { ...bounds, kind: "percentage", percentage: Number(tier.percentage) };
    }
    if (tier.kind === "amount_off") {
      return {
        ...bounds,
        kind: "amount_off",
        amount: readMoney(tier.amount, `tier ${index}`),
      };
    }
    if (tier.kind === "fixed_price") {
      return {
        ...bounds,
        kind: "fixed_price",
        amount: readMoney(tier.amount, `tier ${index}`),
      };
    }
    throw new Error(`tier ${index} has unknown kind ${String(tier.kind)}`);
  });
}

function readCartValueTiers(value: unknown): CartValueTier[] {
  const raw = (value as { tiers?: unknown })?.tiers;
  if (!Array.isArray(raw)) throw new Error("cart value tiers missing");

  return raw.map((entry, index) => {
    const tier = entry as Record<string, unknown>;
    const bounds = {
      minSubtotal: readMoney(tier.minSubtotal, `tier ${index}.minSubtotal`),
      maxSubtotal:
        tier.maxSubtotal === null || tier.maxSubtotal === undefined
          ? null
          : readMoney(tier.maxSubtotal, `tier ${index}.maxSubtotal`),
    };

    if (tier.kind === "percentage") {
      return { ...bounds, kind: "percentage", percentage: Number(tier.percentage) };
    }
    if (tier.kind === "fixed_price") {
      return {
        ...bounds,
        kind: "fixed_price",
        amount: readMoney(tier.amount, `tier ${index}`),
      };
    }
    throw new Error(`tier ${index} has unknown kind ${String(tier.kind)}`);
  });
}

function readDate(value: unknown, label: string): Date {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is not a date`);
  return date;
}

function readRule(raw: unknown): ReadResult {
  const rule = raw as Partial<SerializedRule>;
  const id = typeof rule?.id === "string" ? rule.id : null;

  try {
    if (!id) throw new Error("rule has no id");
    if (typeof rule.name !== "string") throw new Error("rule has no name");
    if (!rule.targets || !rule.audience)
      throw new Error("rule has no targets or audience");

    const base = {
      id,
      name: rule.name,
      status: rule.status as RuleStatus,
      priority: Number(rule.priority),
      combinable: Boolean(rule.combinable),
      targets: rule.targets,
      audience: rule.audience,
      markets: rule.markets ?? { mode: "all" as const, marketIds: [] },
      schedule: {
        startsAt: rule.startsAt ? readDate(rule.startsAt, "startsAt") : null,
        endsAt: rule.endsAt ? readDate(rule.endsAt, "endsAt") : null,
      },
      createdAt: readDate(rule.createdAt, "createdAt"),
    };

    if (!Number.isFinite(base.priority)) throw new Error("rule has no priority");

    switch (rule.kind) {
      case "percentage":
        return {
          rule: {
            ...base,
            kind: "percentage",
            value: {
              percentage: Number((rule.value as { percentage: unknown })?.percentage),
            },
          },
        };
      case "fixed_price":
        return {
          ...{},
          rule: {
            ...base,
            kind: "fixed_price",
            value: readCurrencyAmount(rule.value, "value"),
          },
        };
      case "amount_off":
        return {
          rule: {
            ...base,
            kind: "amount_off",
            value: readCurrencyAmount(rule.value, "value"),
          },
        };
      case "volume_tier":
        return {
          rule: {
            ...base,
            kind: "volume_tier",
            value: { tiers: readVolumeTiers(rule.value) },
          },
        };
      case "cart_value_tier":
        return {
          rule: {
            ...base,
            kind: "cart_value_tier",
            value: { tiers: readCartValueTiers(rule.value) },
          },
        };
      default:
        throw new Error(`unknown rule kind ${String(rule.kind)}`);
    }
  } catch (error) {
    return {
      error: {
        ruleId: id,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

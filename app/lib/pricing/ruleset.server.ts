import { createHash } from "node:crypto";

import { serializeRuleset, type PricingRule } from "@mannon/pricing-engine";

import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { runMutation, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/** The app-reserved namespace. Only this app can read or write it. */
export const MANNON_NAMESPACE = "$app:mannon";
export const RULESET_KEY = "ruleset";

/**
 * Shopify caps a metafield value at 64 KB and a Function's input has its own
 * budget, so a very large ruleset has to fail loudly rather than be truncated
 * into silently wrong prices. Well below the cap, to leave room for the rest
 * of the Function input.
 */
export const RULESET_BYTE_LIMIT = 48 * 1024;

export class RulesetTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly ruleCount: number,
  ) {
    super(
      `The published ruleset is ${bytes} bytes across ${ruleCount} rules, over the ` +
        `${RULESET_BYTE_LIMIT}-byte limit for a Shopify metafield. Prices at checkout ` +
        `were not changed. Archive unused rules, or split targeting across products.`,
    );
    this.name = "RulesetTooLargeError";
  }
}

const CREATE_DISCOUNT = `#graphql
  mutation MannonCreateDiscount($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount {
        discountId
      }
      userErrors {
        code
        field
        message
      }
    }
  }`;

const SET_METAFIELDS = `#graphql
  mutation MannonSetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        namespace
      }
      userErrors {
        field
        message
      }
    }
  }`;

const FIND_FUNCTION = `#graphql
  query MannonDiscountFunction {
    shopifyFunctions(first: 25, apiType: "discount") {
      nodes {
        id
        title
        apiType
      }
    }
  }`;

export function rulesetPayload(rules: PricingRule[]): {
  json: string;
  hash: string;
  bytes: number;
} {
  const json = JSON.stringify(serializeRuleset(rules));
  return {
    json,
    hash: createHash("sha256").update(json).digest("hex"),
    bytes: Buffer.byteLength(json, "utf8"),
  };
}

/**
 * The deployed Function's id.
 *
 * Configurable, because the id is stamped at deploy time and an operator may
 * need to pin it; discovered from the Admin API otherwise.
 */
export async function resolveFunctionId(admin: AdminGraphql): Promise<string> {
  const configured = process.env.SHOPIFY_DISCOUNT_FUNCTION_ID;
  if (configured) return configured;

  const response = await admin.graphql(FIND_FUNCTION);
  const body = (await response.json()) as {
    data?: { shopifyFunctions?: { nodes?: { id: string; title: string }[] } };
  };

  const node = body.data?.shopifyFunctions?.nodes?.[0];
  if (!node) {
    throw new Error(
      "No deployed discount Function found for this app. Run `shopify app deploy` " +
        "first, or set SHOPIFY_DISCOUNT_FUNCTION_ID.",
    );
  }
  return node.id;
}

/**
 * Make sure this shop has the automatic discount that runs Mannon's Function.
 *
 * One discount per shop, created once and remembered. It carries the ruleset as
 * a metafield, so the configuration travels with the discount it drives.
 */
/**
 * What a wholesale price may stack with at checkout.
 *
 * `productDiscounts` is the merchant's Settings choice: a product discount is
 * the one that lands on the same line as the wholesale price, so stacking is
 * how a trade price becomes a giveaway.
 *
 * This used to be three hardcoded booleans inside `ensureDiscount`, which
 * returns early once a discount exists — so the store-wide gate the Settings
 * page calls "the store-wide gate", complete with a warning banner and a
 * count of affected rules, changed nothing at checkout, ever.
 */
export const combinesWith = (allowShopifyDiscounts: boolean) => ({
  orderDiscounts: true,
  productDiscounts: allowShopifyDiscounts,
  shippingDiscounts: true,
});

/**
 * Which discount classes this app's discount is allowed to produce.
 *
 * The Function's very first statement is
 * `if (!input.discount.discountClasses.includes("PRODUCT")) return NOTHING`,
 * because Shopify decides per discount which classes a Function may generate
 * and the Function must not hand back an operation it has not been permitted.
 * The create mutation left this field off entirely, so the app's own discount
 * was never granted the one class it exists to produce — a discount that ran on
 * every cart and returned nothing on every cart, with no error anywhere.
 *
 * `PRODUCT` and nothing else: Mannon changes a line's unit price. It never
 * discounts an order total or shipping, and asking for classes it does not use
 * would let a future bug apply one.
 */
export const DISCOUNT_CLASSES = ["PRODUCT"] as const;

const UPDATE_DISCOUNT = `#graphql
  mutation MannonUpdateDiscount($id: ID!, $discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }`;

export async function ensureDiscount(
  admin: AdminGraphql,
  rules: PricingRule[],
): Promise<string> {
  const shop = shopScope.require("ensureDiscount");
  const existing = await db.shop.findUnique({ where: { shop } });

  if (existing?.discountId) {
    // Stores that installed before `discountClasses` was sent carry a discount
    // Shopify never granted the PRODUCT class, so their Function returns
    // nothing on every cart. Repaired once, here, rather than leaving those
    // merchants to reinstall.
    await syncDiscountClasses(admin, existing.discountId, existing.discountClassesAt);
    await syncCombinations(admin, existing.discountId, existing.allowShopifyDiscounts);
    return existing.discountId;
  }

  const functionId = await resolveFunctionId(admin);
  const { json } = rulesetPayload(rules);

  const discountId = await runMutation<string>(
    admin,
    "discountAutomaticAppCreate",
    CREATE_DISCOUNT,
    {
      discount: {
        functionId,
        title: "Mannon wholesale pricing",
        // No end date: wholesale pricing is not a promotion.
        startsAt: new Date().toISOString(),
        // Without this the Function is not permitted to produce a product
        // discount, and it refuses to run at all.
        discountClasses: [...DISCOUNT_CLASSES],
        combinesWith: combinesWith(existing?.allowShopifyDiscounts ?? false),
        metafields: [
          {
            namespace: MANNON_NAMESPACE,
            key: RULESET_KEY,
            type: "json",
            value: json,
          },
        ],
      },
    },
    (data) => {
      const payload = data.discountAutomaticAppCreate as {
        automaticAppDiscount?: { discountId?: string };
        userErrors: { message: string }[];
      };
      return {
        result: payload.automaticAppDiscount?.discountId ?? "",
        userErrors: payload.userErrors,
      };
    },
  );

  if (!discountId) {
    throw new Error("Shopify created the discount but returned no id");
  }

  await db.shop.update({
    where: { shop },
    // The combinations are set on the create, so record them as pushed — a
    // fresh discount does not need an update call to say what it already says.
    data: {
      discountId,
      discountFunctionId: functionId,
      combinationsHash: existing?.allowShopifyDiscounts ? "allow" : "deny",
      // Sent on the create, so nothing has to repair it afterwards.
      discountClassesAt: new Date(),
    },
  });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "pricing.discount_created",
    summary: "Created the automatic discount that applies wholesale prices at checkout.",
    subject: { type: "Discount", id: discountId },
    metadata: { functionId },
  });

  return discountId;
}

export interface PublishResult {
  status: "published" | "unchanged";
  ruleCount: number;
  bytes: number;
}

/**
 * Push the active ruleset to Shopify so checkout prices match the admin.
 *
 * Called whenever rules change. Nothing else keeps the two in step: the
 * Function cannot call our API, so anything not published here simply does not
 * exist at checkout.
 */
export async function publishRuleset(
  admin: AdminGraphql,
  rules: PricingRule[],
): Promise<PublishResult> {
  const shop = shopScope.require("publishRuleset");
  const { json, hash, bytes } = rulesetPayload(rules);

  if (bytes > RULESET_BYTE_LIMIT) {
    throw new RulesetTooLargeError(bytes, rules.length);
  }

  const record = await db.shop.findUnique({ where: { shop } });

  // An unchanged ruleset is a no-op: saving an unrelated setting should not
  // spend an API call or churn the discount.
  if (record?.rulesetHash === hash && record.discountId) {
    return { status: "unchanged", ruleCount: rules.length, bytes };
  }

  const discountId = await ensureDiscount(admin, rules);

  await runMutation<void>(
    admin,
    "metafieldsSet",
    SET_METAFIELDS,
    {
      metafields: [
        {
          ownerId: discountId,
          namespace: MANNON_NAMESPACE,
          key: RULESET_KEY,
          type: "json",
          value: json,
        },
      ],
    },
    (data) => {
      const payload = data.metafieldsSet as { userErrors: { message: string }[] };
      return { result: undefined, userErrors: payload.userErrors };
    },
  );

  await db.shop.update({
    where: { shop },
    data: {
      rulesetHash: hash,
      rulesetPublishedAt: new Date(),
      rulesetRuleCount: rules.length,
    },
  });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "pricing.ruleset_published",
    summary: `Published ${rules.length} pricing rule${rules.length === 1 ? "" : "s"} to checkout.`,
    subject: { type: "Discount", id: discountId },
    metadata: { ruleCount: rules.length, bytes },
  });

  return { status: "published", ruleCount: rules.length, bytes };
}

/**
 * Push the combination choice to the live discount.
 *
 * Hashed against `combinationsHash` so a rule save does not spend an API call
 * re-stating a setting that has not moved.
 */
/**
 * Grant an existing discount the PRODUCT class, once.
 *
 * Idempotent by the stamp rather than by asking Shopify: one extra mutation the
 * first time this runs for a shop, and none ever again.
 */
async function syncDiscountClasses(
  admin: AdminGraphql,
  discountId: string,
  syncedAt: Date | null,
): Promise<void> {
  if (syncedAt) return;
  const shop = shopScope.require("syncDiscountClasses");

  await runMutation<void>(
    admin,
    "discountAutomaticAppUpdate(discountClasses)",
    UPDATE_DISCOUNT,
    { id: discountId, discount: { discountClasses: [...DISCOUNT_CLASSES] } },
    (data) => {
      const payload = data.discountAutomaticAppUpdate as {
        userErrors: { message: string }[];
      };
      return { result: undefined, userErrors: payload.userErrors };
    },
  );

  await db.shop.update({ where: { shop }, data: { discountClassesAt: new Date() } });
}

async function syncCombinations(
  admin: AdminGraphql,
  discountId: string,
  allowShopifyDiscounts: boolean,
): Promise<void> {
  const shop = shopScope.require("syncCombinations");
  const want = allowShopifyDiscounts ? "allow" : "deny";
  const record = await db.shop.findUnique({ where: { shop } });
  if (record?.combinationsHash === want) return;

  await runMutation<void>(
    admin,
    "discountAutomaticAppUpdate(combinesWith)",
    UPDATE_DISCOUNT,
    { id: discountId, discount: { combinesWith: combinesWith(allowShopifyDiscounts) } },
    (data) => {
      const payload = data.discountAutomaticAppUpdate as {
        userErrors: { message: string }[];
      };
      return { result: undefined, userErrors: payload.userErrors };
    },
  );

  await db.shop.update({ where: { shop }, data: { combinationsHash: want } });
}

/**
 * Repair a discount Shopify never granted the PRODUCT class.
 *
 * Called from the `/app` layout loader rather than only from `ensureDiscount`,
 * and that matters: `ensureDiscount` runs when rules are published, so a
 * merchant whose store already had its rules set up would have had **no
 * wholesale pricing at checkout at all** until they happened to edit a rule.
 * There is no signal anywhere that would have sent them to do it.
 *
 * Costs one Admin call, once per shop, and nothing afterwards — the stamp is
 * read from the record the caller already loaded. Failure is swallowed: a
 * merchant must not get an error page because a repair could not be made, and
 * the next page view tries again.
 */
export async function repairDiscountClasses(
  admin: AdminGraphql,
  record: { discountId: string | null; discountClassesAt: Date | null },
): Promise<void> {
  if (!record.discountId || record.discountClassesAt) return;

  try {
    await syncDiscountClasses(admin, record.discountId, record.discountClassesAt);
  } catch (error) {
    console.error(
      `[mannon] could not grant the discount its PRODUCT class: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

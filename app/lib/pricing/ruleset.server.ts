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
export async function ensureDiscount(
  admin: AdminGraphql,
  rules: PricingRule[],
): Promise<string> {
  const shop = shopScope.require("ensureDiscount");
  const existing = await db.shop.findUnique({ where: { shop } });
  if (existing?.discountId) return existing.discountId;

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
        combinesWith: {
          orderDiscounts: true,
          productDiscounts: false,
          shippingDiscounts: true,
        },
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
    data: { discountId, discountFunctionId: functionId },
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

import type { SerializedBuyerTerms } from "@mannon/net-terms";

import { runMutation, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { MANNON_NAMESPACE } from "~/lib/pricing/ruleset.server";

export const BUYER_FACTS_KEY = "buyer";

/**
 * What the discount Function needs to know about a buyer.
 *
 * The Function's input query is fixed at deploy time and serves every merchant,
 * so `Customer.hasAnyTag` cannot be handed a particular shop's tag list. The
 * facts have to travel to checkout as data, which is what this metafield is.
 */
export interface BuyerFacts {
  tags: string[];
  /** Mannon customer groups. Empty until groups exist (phase 2.1). */
  groupIds: string[];
  /**
   * Net payment terms, when this buyer has any (phase 3.2).
   *
   * It rides on the same metafield rather than a second one: two metafields
   * would be two things to keep in step, and a buyer whose tags published but
   * whose terms did not is a buyer priced correctly and refused credit.
   *
   * Null means no terms, which is what every Function reading it treats as
   * "do not offer to pay later".
   */
  terms: SerializedBuyerTerms | null;
}

const SET_METAFIELDS = `#graphql
  mutation MannonSetBuyerFacts($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

/** Tags arrive from Shopify with inconsistent spacing and case. */
export function normalizeBuyerFacts(facts: {
  tags?: string[] | string | null;
  groupIds?: string[] | null;
  terms?: SerializedBuyerTerms | null;
}): BuyerFacts {
  const raw =
    typeof facts.tags === "string"
      ? facts.tags.split(",")
      : Array.isArray(facts.tags)
        ? facts.tags
        : [];

  const tags = [...new Set(raw.map((tag) => tag.trim()).filter(Boolean))].sort();
  const groupIds = [...new Set(facts.groupIds ?? [])].sort();

  return { tags, groupIds, terms: facts.terms ?? null };
}

/**
 * Publish a customer's facts so checkout can price for them.
 *
 * Until this runs for a buyer, tag-targeted rules do not apply to them at
 * checkout even though the admin shows the right price — which is precisely
 * the disagreement this app exists to avoid, so it runs on every customer
 * create and update.
 */
export async function publishBuyerFacts(
  admin: AdminGraphql,
  customerId: string,
  facts: {
    tags?: string[] | string | null;
    groupIds?: string[] | null;
    /**
     * Required, not optional, on purpose. Omitting it publishes `null`, which
     * tells checkout the buyer has no terms — so a caller that forgot would
     * quietly withdraw credit a merchant had granted. Making it explicit turns
     * that into a compile error instead. `publishBuyerTerms` computes it.
     */
    terms: SerializedBuyerTerms | null;
  },
): Promise<BuyerFacts> {
  const normalized = normalizeBuyerFacts(facts);

  await runMutation<void>(
    admin,
    "metafieldsSet(buyer)",
    SET_METAFIELDS,
    {
      metafields: [
        {
          ownerId: customerId,
          namespace: MANNON_NAMESPACE,
          key: BUYER_FACTS_KEY,
          type: "json",
          value: JSON.stringify(normalized),
        },
      ],
    },
    (data) => {
      const payload = data.metafieldsSet as { userErrors: { message: string }[] };
      return { result: undefined, userErrors: payload.userErrors };
    },
  );

  return normalized;
}

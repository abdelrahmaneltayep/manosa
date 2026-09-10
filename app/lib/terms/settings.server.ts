import { createHash } from "node:crypto";

import { deserializeSettings, serializeSettings } from "@mannon/net-terms";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { assertFeature } from "~/lib/billing/gate.server";
import { runMutation, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { MANNON_NAMESPACE } from "~/lib/pricing/ruleset.server";
import { shopGid } from "~/lib/shop/domains.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The store-wide terms settings, and getting them to checkout.
 *
 * Same shape as the limits (`docs/adr/0014`): the payment customization
 * Function cannot call our API, so what is the same for every buyer travels as
 * a shop metafield. What is true of *one* buyer rides on their own metafield
 * with the pricing facts — see `publishBuyerTerms`.
 */

export const TERMS_SETTINGS_KEY = "terms";

const SET_METAFIELDS = `#graphql
  mutation MannonSetTermsSettings($metafields: [MetafieldsSetInput!]!) {
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

export interface TermsSettingsInput {
  methodName: string;
  showDaysInName: boolean;
  overdueBlocks: boolean;
}

export async function saveTermsSettings(
  input: TermsSettingsInput,
  { admin, actor }: { admin: AdminGraphql; actor: AuditActor },
) {
  await assertFeature("net_terms");
  const shop = shopScope.require("saveTermsSettings");

  const methodName = input.methodName.trim();
  if (!methodName) {
    // The Function matches the payment method by name. An empty one would
    // match every method, hiding the whole payment step from every buyer.
    throw new Response("A payment method name is required", { status: 400 });
  }

  await db.shop.update({
    where: { shop },
    data: {
      termsMethodName: methodName,
      termsShowDays: input.showDaysInName,
      termsOverdueBlocks: input.overdueBlocks,
    },
  });

  await recordAudit({
    actor,
    action: "terms.settings_updated",
    summary: `Changed how paying later appears at checkout.`,
    subject: { type: "Shop", id: shop },
    metadata: { ...input, methodName },
  });

  return publishTermsSettings(admin);
}

/**
 * Push the settings to Shopify.
 *
 * Unpublished settings are not a small problem: the Function falls back to its
 * own defaults, so a merchant who renamed their payment method would find it
 * shown to everybody. The pages say when this has not run.
 */
export async function publishTermsSettings(admin: AdminGraphql) {
  const shop = shopScope.require("publishTermsSettings");
  const record = await db.shop.findUnique({ where: { shop } });

  const payload = serializeSettings({
    methodName: record?.termsMethodName,
    showDaysInName: record?.termsShowDays ?? true,
    overdueBlocks: record?.termsOverdueBlocks ?? true,
  });

  const value = JSON.stringify(payload);
  const hash = createHash("sha256").update(value).digest("hex");

  if (record?.termsSettingsHash === hash) return { published: false };

  const ownerId = await shopGid(admin);

  await runMutation<void>(
    admin,
    "metafieldsSet(terms)",
    SET_METAFIELDS,
    {
      metafields: [
        {
          ownerId,
          namespace: MANNON_NAMESPACE,
          key: TERMS_SETTINGS_KEY,
          type: "json",
          value,
        },
      ],
    },
    (data) => {
      const result = data.metafieldsSet as { userErrors: { message: string }[] };
      return { result: undefined, userErrors: result.userErrors };
    },
  );

  await db.shop.update({
    where: { shop },
    data: { termsSettingsHash: hash, termsPublishedAt: new Date() },
  });

  return { published: true };
}

/** The settings as the Function will read them, for the admin's preview. */
export async function currentSettings() {
  const shop = shopScope.require("currentSettings");
  const record = await db.shop.findUnique({ where: { shop } });

  return deserializeSettings(
    serializeSettings({
      methodName: record?.termsMethodName,
      showDaysInName: record?.termsShowDays ?? true,
      overdueBlocks: record?.termsOverdueBlocks ?? true,
    }),
  );
}

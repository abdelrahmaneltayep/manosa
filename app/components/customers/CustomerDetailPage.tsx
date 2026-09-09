import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";

import type { CustomerDetailView } from "~/components/customers/types";

/**
 * One buyer: their tier, their tags, a staff-only note, and the tax-exempt
 * flag.
 *
 * Every write here goes to Shopify as well as to our mirror, because Shopify
 * owns the customer. What the page must never do is look as though it saved
 * something we only wrote locally.
 */
export function CustomerDetailPage({ view }: { view: CustomerDetailView }) {
  const { t } = useTranslation();
  const { customer } = view;

  return (
    <s-page heading={customer.name}>
      {customer.deletedInShopify ? (
        <s-section>
          <s-banner tone="critical">
            <s-heading>{t("customers.detail.deletedHeading")}</s-heading>
            <s-paragraph>{t("customers.detail.deletedBody")}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {view.vatRequired ? (
        <s-section>
          <s-banner tone="warning">
            <s-heading>{t("customers.detail.vatRequiredHeading")}</s-heading>
            <s-paragraph>{t("customers.detail.vatRequiredBody")}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <s-section heading={t("customers.detail.aboutHeading")}>
        <s-stack direction="block" gap="small-500">
          {customer.email ? <s-text>{customer.email}</s-text> : null}
          {customer.phone ? <s-text>{customer.phone}</s-text> : null}
          {customer.countryCode ? <s-text>{customer.countryCode}</s-text> : null}
          <s-text color="subdued">
            {/* Shopify's own lifetime total, not a price this app computed. */}
            {t("customers.detail.spend", {
              amount: customer.lifetimeSpend,
              count: customer.orderCount,
            })}
          </s-text>
          <s-text color="subdued">
            {t("customers.detail.syncedAt", { at: customer.syncedAt })}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading={t("customers.detail.groupHeading")}>
        <form method="post">
          <input type="hidden" name="intent" value="changeGroup" />
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-select
              name="groupId"
              label={t("customers.list.changeGroup")}
              value={customer.group?.id ?? ""}
              {...whenDisabled(customer.deletedInShopify)}
            >
              <s-option value="">{t("customers.list.noGroup")}</s-option>
              {view.groups.map((group) => (
                <s-option key={group.id} value={group.id}>
                  {group.name}
                </s-option>
              ))}
            </s-select>
            <s-button
              type="submit"
              variant="primary"
              {...whenDisabled(customer.deletedInShopify)}
            >
              {t("customers.list.move")}
            </s-button>
          </s-stack>
        </form>
        <s-paragraph color="subdued">{t("customers.list.repriceNote")}</s-paragraph>
      </s-section>

      <s-section heading={t("customers.detail.tagsHeading")}>
        <form method="post">
          <input type="hidden" name="intent" value="setTags" />
          <s-stack direction="block" gap="small">
            <s-text-field
              name="tags"
              label={t("customers.detail.tagsLabel")}
              details={t("customers.detail.tagsHelp")}
              value={customer.tags.join(", ")}
              {...whenDisabled(customer.deletedInShopify)}
            />
            {view.knownTags.length > 0 ? (
              <s-stack direction="inline" gap="small-500">
                <s-text color="subdued">{t("customers.detail.knownTags")}</s-text>
                {view.knownTags.slice(0, 12).map((tag) => (
                  <s-badge key={tag} tone="neutral">
                    {tag}
                  </s-badge>
                ))}
              </s-stack>
            ) : null}
            <s-button
              type="submit"
              {...whenDisabled(customer.deletedInShopify)}
              {...(view.saving ? { loading: true } : {})}
            >
              {t("customers.detail.saveTags")}
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading={t("customers.detail.taxHeading")}>
        <form method="post">
          <input type="hidden" name="intent" value="setTaxExempt" />
          <input type="hidden" name="taxExempt" value={customer.taxExempt ? "0" : "1"} />
          <s-stack direction="block" gap="small">
            <s-text>
              {customer.taxExempt
                ? t("customers.detail.taxExemptOn")
                : t("customers.detail.taxExemptOff")}
            </s-text>
            {customer.vatNumber ? (
              <s-stack direction="inline" gap="small-500" alignItems="center">
                <s-text>{customer.vatNumber}</s-text>
                <s-badge tone={customer.vatVerifiedAt ? "success" : "neutral"}>
                  {customer.vatVerifiedAt
                    ? t("customers.detail.vatVerified")
                    : /* Unverified is not invalid. A VIES outage must never
                         brand a real buyer as fraudulent. */
                      t("customers.detail.vatUnverified")}
                </s-badge>
              </s-stack>
            ) : (
              <s-text color="subdued">{t("customers.detail.noVat")}</s-text>
            )}
            <s-button type="submit" {...whenDisabled(customer.deletedInShopify)}>
              {customer.taxExempt
                ? t("customers.detail.removeTaxExempt")
                : t("customers.detail.markTaxExempt")}
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading={t("customers.detail.noteHeading")}>
        <form method="post">
          <input type="hidden" name="intent" value="setNote" />
          <s-stack direction="block" gap="small">
            <s-text-area
              name="note"
              label={t("customers.detail.noteLabel")}
              details={t("customers.detail.noteHelp")}
              value={customer.internalNote ?? ""}
            />
            <s-button type="submit">{t("customers.detail.saveNote")}</s-button>
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
}

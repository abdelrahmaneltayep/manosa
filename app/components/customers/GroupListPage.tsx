import { useTranslation } from "react-i18next";

import type { GroupListView, GroupRowView } from "~/components/customers/types";

/**
 * Customer groups — the tiers a merchant sells against.
 *
 * The delete flow is the part worth care: a group is a bundle of pricing,
 * terms and limits, so removing one changes what its members pay. The
 * destination is asked for, never assumed.
 */
export function GroupListPage({ view }: { view: GroupListView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("customers.groups.heading")}>
      {view.error === "duplicate_handle" ? (
        <s-section>
          <s-banner tone="critical">
            <s-heading>{t("customers.groups.duplicateHeading")}</s-heading>
            <s-paragraph>{t("customers.groups.duplicateBody")}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {view.blockedDelete ? <BlockedDelete view={view} /> : null}

      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href="/app/customers">{t("customers.list.tabBuyers")}</s-link>
          <s-link href="/app/customers/groups" aria-current="page">
            {t("customers.list.tabGroups")}
          </s-link>
          <s-link href="/app/customers/tagging">{t("customers.list.tabTagging")}</s-link>
        </s-stack>
      </s-section>

      {view.rows.length === 0 ? (
        <EmptyState view={view} />
      ) : (
        <s-section>
          <s-stack direction="block" gap="base">
            <GroupTable view={view} />
            <NewGroupForm />
            {view.templates.length > 0 ? <Templates view={view} /> : null}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

function EmptyState({ view }: { view: GroupListView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("customers.groups.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">{t("customers.groups.emptyBody")}</s-paragraph>
        <Templates view={view} />
        <NewGroupForm />
      </s-stack>
    </s-section>
  );
}

function Templates({ view }: { view: GroupListView }) {
  const { t } = useTranslation();

  return (
    <form method="post">
      <input type="hidden" name="intent" value="starters" />
      <s-stack direction="block" gap="small">
        <s-text color="subdued">
          {t("customers.groups.templatesLabel", {
            names: view.templates.map((template) => template.name).join(" · "),
          })}
        </s-text>
        <s-button type="submit" variant="primary">
          {t("customers.groups.createStarters", { count: view.templates.length })}
        </s-button>
      </s-stack>
    </form>
  );
}

function NewGroupForm() {
  const { t } = useTranslation();

  return (
    <form method="post">
      <input type="hidden" name="intent" value="create" />
      <s-stack direction="inline" gap="small" alignItems="end">
        <s-text-field name="name" label={t("customers.groups.nameLabel")} />
        <s-text-field
          name="tag"
          label={t("customers.groups.tagLabel")}
          details={t("customers.groups.tagHelp")}
        />
        <s-number-field
          name="netTermsDays"
          label={t("customers.groups.termsLabel")}
          details={t("customers.groups.termsHelp")}
        />
        <s-button type="submit">{t("customers.groups.create")}</s-button>
      </s-stack>
    </form>
  );
}

function GroupTable({ view }: { view: GroupListView }) {
  const { t } = useTranslation();

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{t("customers.groups.colName")}</s-table-header>
        <s-table-header>{t("customers.groups.colTag")}</s-table-header>
        <s-table-header>{t("customers.groups.colMembers")}</s-table-header>
        <s-table-header>{t("customers.groups.colPricing")}</s-table-header>
        <s-table-header>{t("customers.groups.colTerms")}</s-table-header>
        <s-table-header>{t("customers.groups.colActions")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.rows.map((row) => (
          <GroupRow key={row.id} row={row} />
        ))}
      </s-table-body>
    </s-table>
  );
}

function GroupRow({ row }: { row: GroupRowView }) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        <s-link href={`/app/customers/groups/${row.id}`}>{row.name}</s-link>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone="info">{row.tag}</s-badge>
      </s-table-cell>
      <s-table-cell>
        <s-text fontVariantNumeric="tabular-nums">{row.memberCount}</s-text>
      </s-table-cell>
      <s-table-cell>
        {row.pricingRuleCount === 0 ? (
          // A tier with no pricing attached is a label, not a tier. Saying so
          // here is cheaper than a merchant wondering why nobody gets a
          // discount.
          <s-badge tone="caution">{t("customers.groups.noPricing")}</s-badge>
        ) : (
          <s-text fontVariantNumeric="tabular-nums">
            {t("customers.groups.pricingRules", { count: row.pricingRuleCount })}
          </s-text>
        )}
      </s-table-cell>
      <s-table-cell>
        {row.terms ?? <s-text color="subdued">{t("customers.list.prepaid")}</s-text>}
      </s-table-cell>
      <s-table-cell>
        <form method="post">
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="groupId" value={row.id} />
          <s-button type="submit" variant="tertiary" tone="critical">
            {t("customers.groups.delete")}
          </s-button>
        </form>
      </s-table-cell>
    </s-table-row>
  );
}

/** The guard: members must be sent somewhere before the group can go. */
function BlockedDelete({ view }: { view: GroupListView }) {
  const { t } = useTranslation();
  const blocked = view.blockedDelete!;

  return (
    <s-section>
      <s-banner tone="warning">
        <s-heading>
          {t("customers.groups.blockedHeading", {
            name: blocked.name,
            count: blocked.memberCount,
          })}
        </s-heading>
        <s-paragraph>{t("customers.groups.blockedBody")}</s-paragraph>
        <form method="post">
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="groupId" value={blocked.id} />
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-select
              name="destinationId"
              label={t("customers.groups.destinationLabel")}
              value=""
            >
              <s-option value="">{t("customers.groups.destinationChoose")}</s-option>
              {view.destinations.map((destination) => (
                <s-option key={destination.id} value={destination.id}>
                  {destination.name}
                </s-option>
              ))}
              {/* Explicit rather than implied: "no group" is a decision with a
                  price consequence, so the merchant has to pick it. */}
              <s-option value="none">{t("customers.groups.destinationNone")}</s-option>
            </s-select>
            <s-button type="submit" tone="critical">
              {t("customers.groups.confirmDelete")}
            </s-button>
            <s-link href="/app/customers/groups">{t("customers.groups.cancel")}</s-link>
          </s-stack>
        </form>
      </s-banner>
    </s-section>
  );
}

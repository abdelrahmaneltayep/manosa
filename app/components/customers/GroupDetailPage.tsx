import { useTranslation } from "react-i18next";

import type { GroupDetailView } from "~/components/customers/types";

/**
 * A group is a bundle, so its page is the bundle: pricing, limits, terms,
 * shipping and visibility, each linking to the feature that owns it.
 *
 * Sections whose feature has not shipped say which phase they arrive in rather
 * than showing a control that quietly does nothing — a merchant who sets a
 * limit that is not enforced finds out from an order that should not have gone
 * through.
 */
export function GroupDetailPage({ view }: { view: GroupDetailView }) {
  const { t } = useTranslation();
  const { group } = view;

  return (
    <s-page heading={group.name}>
      <s-section>
        <s-link href="/app/customers/groups">{t("customers.group.backToGroups")}</s-link>
      </s-section>

      <ui-save-bar id="group-save-bar">
        <button variant="primary" id="group-save" />
        <button id="group-discard" />
      </ui-save-bar>

      {view.error === "duplicate_handle" ? (
        <s-section>
          <s-banner tone="critical">
            <s-heading>{t("customers.groups.duplicateHeading")}</s-heading>
            <s-paragraph>{t("customers.groups.duplicateBody")}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <s-section heading={t("customers.group.detailsHeading")}>
        <form method="post">
          <input type="hidden" name="intent" value="save" />
          <s-stack direction="block" gap="small">
            <s-text-field
              name="name"
              label={t("customers.groups.nameLabel")}
              value={group.name}
            />
            <s-text-field
              name="tag"
              label={t("customers.groups.tagLabel")}
              details={t("customers.groups.tagHelp")}
              value={group.tag}
            />
            <s-text-area
              name="description"
              label={t("customers.group.descriptionLabel")}
              value={group.description ?? ""}
            />
            <s-button
              type="submit"
              variant="primary"
              {...(view.saving ? { loading: true } : {})}
            >
              {t("customers.group.save")}
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading={t("customers.group.bundleHeading")}>
        <s-paragraph color="subdued">{t("customers.group.bundleBody")}</s-paragraph>
        <s-unordered-list>
          {view.sections.map((section) => (
            <s-list-item key={section.key}>
              <s-stack direction="block" gap="small-500">
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <s-text type="strong">
                    {t(`customers.group.section.${section.key}`)}
                  </s-text>
                  {section.comingIn ? (
                    <s-badge tone="neutral">
                      {t("customers.group.comingIn", { phase: section.comingIn })}
                    </s-badge>
                  ) : null}
                </s-stack>
                <s-text color="subdued">{section.summary}</s-text>
                {section.href ? (
                  <s-link href={section.href}>
                    {t(`customers.group.sectionLink.${section.key}`)}
                  </s-link>
                ) : null}
              </s-stack>
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-section>

      <s-section
        heading={t("customers.group.membersHeading", { count: view.memberTotal })}
      >
        {view.members.length === 0 ? (
          <s-stack direction="block" gap="small">
            <s-paragraph color="subdued">{t("customers.group.noMembers")}</s-paragraph>
            <s-link href="/app/customers">{t("customers.group.findBuyers")}</s-link>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>{t("customers.list.colName")}</s-table-header>
              <s-table-header>{t("customers.list.colSpend")}</s-table-header>
              <s-table-header>{t("customers.list.colLastOrder")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {view.members.map((member) => (
                <s-table-row key={member.id}>
                  <s-table-cell>
                    <s-link href={`/app/customers/${member.id}`}>{member.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text fontVariantNumeric="tabular-nums">
                      {member.lifetimeSpend}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    {member.lastOrderAt === null ? (
                      <s-text color="subdued">{t("customers.list.neverOrdered")}</s-text>
                    ) : (
                      <s-text fontVariantNumeric="tabular-nums">
                        {t("customers.list.daysAgo", {
                          count: member.daysSinceLastOrder ?? 0,
                        })}
                      </s-text>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <MemberPagination view={view} />
      </s-section>
    </s-page>
  );
}

/**
 * Every list paginates. A tier with three hundred members would otherwise show
 * the first fifty and give no hint the rest exist.
 */
function MemberPagination({ view }: { view: GroupDetailView }) {
  const { t } = useTranslation();
  if (view.memberTotal <= view.pageSize) return null;

  const from = (view.page - 1) * view.pageSize + 1;
  const to = Math.min(view.page * view.pageSize, view.memberTotal);
  const link = (page: number) => `?page=${page}`;

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {view.page > 1 ? (
        <s-link href={link(view.page - 1)}>{t("customers.list.previous")}</s-link>
      ) : null}
      <s-text color="subdued" fontVariantNumeric="tabular-nums">
        {t("customers.list.showing", { from, to, total: view.memberTotal })}
      </s-text>
      {to < view.memberTotal ? (
        <s-link href={link(view.page + 1)}>{t("customers.list.next")}</s-link>
      ) : null}
    </s-stack>
  );
}

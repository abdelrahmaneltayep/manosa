import { useTranslation } from "react-i18next";

import { whenChecked, whenDisabled } from "~/components/boolean-attribute";
import type { SettingsIssueView, SettingsView } from "~/components/settings/types";

/**
 * Settings, a card at a time.
 *
 * Checklist §8: *"Each section its own card page with save bar; risky toggles
 * carry the explicit warning + link to affected rules count."*
 *
 * Each section is its own `<form>` posting only its own fields, so one
 * section's validation error cannot silently discard another's unsaved work —
 * and each carries its own save bar, which is what "its own card page" means
 * inside a single route.
 */
export function SettingsPage({ view }: { view: SettingsView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("settings.heading")}>
      {view.danger.paused ? (
        <s-section>
          {/* Not only on this page. A merchant who paused and forgot has no
              other signal that their wholesale prices are switched off. */}
          <s-banner tone="warning">
            <s-heading>{t("settings.danger.pausedHeading")}</s-heading>
            <s-paragraph>{t("settings.danger.pausedBody")}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <Wholesale view={view} />
      <Display view={view} />
      <Discounts view={view} />
      <Tax view={view} />
      <Orders view={view} />
      <Notifications view={view} />
      <DangerZone view={view} />
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

/** The issue for one field, or nothing. Errors sit beside their cause. */
function issueFor(issues: SettingsIssueView[], field: string): string | undefined {
  return issues.find((issue) => issue.field === field)?.message;
}

/** `error` is only set when there is one — an empty string still renders red. */
const withError = (message: string | undefined) => (message ? { error: message } : {});

function Section({
  id,
  view,
  children,
}: {
  id: string;
  view: SettingsView;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const failed = view.failedSection === id;

  return (
    <s-section heading={t(`settings.${id}.heading`)}>
      <form method="post">
        <input type="hidden" name="section" value={id} />

        <ui-save-bar id={`settings-${id}-save-bar`}>
          <button type="submit" variant="primary" />
          <button type="reset" />
        </ui-save-bar>

        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">{t(`settings.${id}.body`)}</s-paragraph>
          {children}

          {failed ? (
            <s-banner tone="critical">
              <s-paragraph>{t("settings.saveFailed")}</s-paragraph>
            </s-banner>
          ) : null}
          {view.saved === id ? (
            <s-banner tone="success">
              <s-paragraph>{t("settings.saved")}</s-paragraph>
            </s-banner>
          ) : null}

          <s-button type="submit" variant="primary">
            {t("settings.save")}
          </s-button>
        </s-stack>
      </form>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */

function Wholesale({ view }: { view: SettingsView }) {
  const { t } = useTranslation();
  const { wholesale, issues } = view;

  return (
    <Section id="wholesale" view={view}>
      <s-text-field
        name="wholesaleTag"
        label={t("settings.wholesale.tagLabel")}
        details={t("settings.wholesale.tagHelp", { count: wholesale.taggedBuyers })}
        value={wholesale.wholesaleTag}
        {...withError(issueFor(issues, "wholesaleTag"))}
      />
      <s-text-field
        name="wholesaleOrderTag"
        label={t("settings.wholesale.orderTagLabel")}
        details={t("settings.wholesale.orderTagHelp")}
        value={wholesale.wholesaleOrderTag}
        {...withError(issueFor(issues, "wholesaleOrderTag"))}
      />
    </Section>
  );
}

function Display({ view }: { view: SettingsView }) {
  const { t } = useTranslation();
  const { display, issues } = view;

  return (
    <Section id="display" view={view}>
      <s-checkbox
        name="showCompareAt"
        label={t("settings.display.compareAtLabel")}
        details={t("settings.display.compareAtHelp")}
        {...whenChecked(display.showCompareAt)}
      />
      <s-checkbox
        name="hidePricesFromGuests"
        label={t("settings.display.hideGuestsLabel")}
        details={t("settings.display.hideGuestsHelp")}
        {...whenChecked(display.hidePricesFromGuests)}
      />
      <s-select
        name="taxDisplay"
        label={t("settings.display.taxLabel")}
        details={t("settings.display.taxHelp")}
        value={display.taxDisplay}
        {...withError(issueFor(issues, "taxDisplay"))}
      >
        <s-option value="excl">{t("settings.display.taxExcl")}</s-option>
        <s-option value="incl">{t("settings.display.taxIncl")}</s-option>
      </s-select>

      {/* The checklist's "storefront preview snippet": what these settings
          make a buyer read, rather than a description of what they do. */}
      <s-box padding="base" borderWidth="base" borderRadius="base">
        <s-stack direction="block" gap="small-100">
          <s-text color="subdued">{t("settings.display.previewLabel")}</s-text>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text type="strong">{display.preview.price}</s-text>
            {display.preview.compareAt ? (
              <s-text color="subdued">
                <s>{display.preview.compareAt}</s>
              </s-text>
            ) : null}
          </s-stack>
          <s-text color="subdued">{display.preview.taxNote}</s-text>
        </s-stack>
      </s-box>
    </Section>
  );
}

function Discounts({ view }: { view: SettingsView }) {
  const { t } = useTranslation();
  const { discounts } = view;

  return (
    <Section id="discounts" view={view}>
      {/* The explicit warning the checklist asks for, with the count *and* a
          way to read the rules it counted — a number a merchant cannot check
          is a number they have to take on trust. */}
      <s-banner tone="warning">
        <s-paragraph>{t("settings.discounts.warning")}</s-paragraph>
        {discounts.combinableRules > 0 ? (
          <s-paragraph>
            {t("settings.discounts.affects", { count: discounts.combinableRules })}{" "}
            <s-link href={discounts.combinableHref}>
              {t("settings.discounts.seeRules")}
            </s-link>
          </s-paragraph>
        ) : (
          <s-paragraph>{t("settings.discounts.affectsNone")}</s-paragraph>
        )}
      </s-banner>

      <s-checkbox
        name="allowShopifyDiscounts"
        label={t("settings.discounts.allowLabel")}
        details={t("settings.discounts.allowHelp")}
        {...whenChecked(discounts.allowShopifyDiscounts)}
      />
    </Section>
  );
}

function Tax({ view }: { view: SettingsView }) {
  const { t } = useTranslation();
  const { tax } = view;

  return (
    <Section id="tax" view={view}>
      <s-checkbox
        name="requireVatForTaxExempt"
        label={t("settings.tax.requireVatLabel")}
        details={t("settings.tax.requireVatHelp")}
        {...whenChecked(tax.requireVatForTaxExempt)}
      />
      {/* Turning this on does not retroactively un-exempt anybody, and a
          merchant is owed that number before they decide. */}
      {tax.requireVatForTaxExempt || tax.exemptWithoutVat === 0 ? null : (
        <s-text color="subdued">
          {t("settings.tax.exemptWithoutVat", { count: tax.exemptWithoutVat })}
        </s-text>
      )}
      <s-checkbox
        name="taxExemptNeedsApproval"
        label={t("settings.tax.needsApprovalLabel")}
        details={t("settings.tax.needsApprovalHelp")}
        {...whenChecked(tax.taxExemptNeedsApproval)}
      />
    </Section>
  );
}

function Orders({ view }: { view: SettingsView }) {
  const { t } = useTranslation();
  const { orders, issues } = view;

  return (
    <Section id="orders" view={view}>
      <s-checkbox
        name="posBypassesLimits"
        label={t("settings.orders.posLabel")}
        details={t("settings.orders.posHelp")}
        {...whenChecked(orders.posBypassesLimits)}
      />
      <s-number-field
        name="quoteExpiryDays"
        label={t("settings.orders.expiryLabel")}
        details={t("settings.orders.expiryHelp")}
        value={String(orders.quoteExpiryDays)}
        {...withError(issueFor(issues, "quoteExpiryDays"))}
      />
      <s-number-field
        name="quoteReminderDays"
        label={t("settings.orders.reminderLabel")}
        details={t("settings.orders.reminderHelp")}
        value={String(orders.quoteReminderDays)}
        {...withError(issueFor(issues, "quoteReminderDays"))}
      />
      {/* A sent quote carries its own dates, copied at send time. Changing
          these never moves a date a buyer has already been given. */}
      {orders.quotesOutstanding > 0 ? (
        <s-text color="subdued">
          {t("settings.orders.outstanding", { count: orders.quotesOutstanding })}
        </s-text>
      ) : null}
    </Section>
  );
}

function Notifications({ view }: { view: SettingsView }) {
  const { t } = useTranslation();
  const { sender, issues } = view;

  return (
    <Section id="notifications" view={view}>
      <s-text-field
        name="senderEmail"
        label={t("settings.notifications.senderLabel")}
        details={t("settings.notifications.senderHelp")}
        value={sender.senderEmail}
        {...withError(issueFor(issues, "senderEmail"))}
      />

      <SenderStatus view={view} />
    </Section>
  );
}

/**
 * Four states, and each says something different about who did what.
 *
 * The one that matters is `unchecked`: this app has never looked at the
 * records. Calling that "unverified" would report a failure on the merchant's
 * side for something that has simply not happened on ours.
 */
function SenderStatus({ view }: { view: SettingsView }) {
  const { t } = useTranslation();
  const { sender } = view;

  if (sender.status === "none") {
    return (
      <s-stack direction="block" gap="small">
        <s-banner tone="info">
          <s-paragraph>
            {sender.fallbackFrom
              ? t("settings.notifications.noneWithFallback", {
                  from: sender.fallbackFrom,
                })
              : t("settings.notifications.noneAtAll")}
          </s-paragraph>
        </s-banner>
        {/* Said here too. A merchant with no provider *and* no address would
            otherwise be shown neither the button nor the reason it is absent,
            and be left to work out for themselves why nothing sends. */}
        {sender.verifiable ? null : (
          <s-text color="subdued">{t("settings.notifications.cannotVerify")}</s-text>
        )}
      </s-stack>
    );
  }

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-badge tone={sender.status === "verified" ? "success" : "warning"}>
          {t(`settings.notifications.status.${sender.status}`)}
        </s-badge>
        {sender.checkedAt ? (
          <s-text color="subdued">
            {t("settings.notifications.checkedAt", { when: sender.checkedAt })}
          </s-text>
        ) : null}
      </s-stack>

      {sender.status === "failed" && sender.error ? (
        <s-banner tone="critical">
          <s-paragraph>{sender.error}</s-paragraph>
        </s-banner>
      ) : null}

      {sender.status === "verified" ? null : (
        <s-banner tone="info">
          <s-paragraph>
            {sender.fallbackFrom
              ? t("settings.notifications.fallback", { from: sender.fallbackFrom })
              : t("settings.notifications.noneAtAll")}
          </s-paragraph>
        </s-banner>
      )}

      {sender.records.length > 0 ? (
        <s-stack direction="block" gap="small">
          <s-text type="strong">{t("settings.notifications.recordsHeading")}</s-text>
          <s-table>
            <s-table-header-row>
              <s-table-header>{t("settings.notifications.colKind")}</s-table-header>
              <s-table-header>{t("settings.notifications.colHost")}</s-table-header>
              <s-table-header>{t("settings.notifications.colValue")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {sender.records.map((record) => (
                <s-table-row key={`${record.kind}-${record.host}`}>
                  <s-table-cell>{record.kind}</s-table-cell>
                  <s-table-cell>{record.host}</s-table-cell>
                  <s-table-cell>{record.value}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      ) : null}

      {/* With no provider configured, "Verify" would check nothing and could
          only report success. Disabled, and the reason is next to it. */}
      {/* Its own form: `s-button` carries no `name`/`value`, so an intent has
          to ride on a hidden input, and Verify must not also save the address
          the merchant is still typing. */}
      <form method="post">
        <input type="hidden" name="section" value="notifications" />
        <input type="hidden" name="intent" value="verify" />
        <s-button type="submit" {...whenDisabled(!sender.verifiable)}>
          {t("settings.notifications.verify")}
        </s-button>
      </form>
      {sender.verifiable ? null : (
        <s-text color="subdued">{t("settings.notifications.cannotVerify")}</s-text>
      )}
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */

function DangerZone({ view }: { view: SettingsView }) {
  const { t } = useTranslation();
  const { danger } = view;

  return (
    <s-section heading={t("settings.danger.heading")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">{t("settings.danger.body")}</s-paragraph>

        {/* Every destructive action confirms — and this one says exactly what
            it stops and what it keeps, because "pause" is the word merchants
            reach for when they mean "uninstall" and it must not be that. */}
        {danger.confirming ? (
          <s-banner tone="warning">
            <s-heading>{t("settings.danger.confirmHeading")}</s-heading>
            <s-paragraph>
              {t("settings.danger.confirmBody", { count: danger.ruleCount })}
            </s-paragraph>
            <s-paragraph>{t("settings.danger.nothingDeleted")}</s-paragraph>
            <form method="post">
              <input type="hidden" name="section" value="danger" />
              <input type="hidden" name="intent" value="pause" />
              <s-stack direction="inline" gap="small">
                <s-button type="submit" variant="primary">
                  {t("settings.danger.confirmPause")}
                </s-button>
                <s-button href="/app/settings" variant="tertiary">
                  {t("settings.danger.cancel")}
                </s-button>
              </s-stack>
            </form>
          </s-banner>
        ) : danger.paused ? (
          <form method="post">
            <input type="hidden" name="section" value="danger" />
            <input type="hidden" name="intent" value="resume" />
            <s-stack direction="block" gap="small">
              <s-text>
                {t("settings.danger.pausedSince", { when: danger.pausedAt })}
              </s-text>
              <s-button type="submit" variant="primary">
                {t("settings.danger.resume", { count: danger.ruleCount })}
              </s-button>
            </s-stack>
          </form>
        ) : (
          <s-stack direction="block" gap="small">
            <s-text color="subdued">
              {t("settings.danger.willStop", { count: danger.ruleCount })}
            </s-text>
            <s-button href="/app/settings?confirm=pause">
              {t("settings.danger.pause")}
            </s-button>
          </s-stack>
        )}

        {/* The checklist asks for the uninstall data policy to be *stated*,
            not linked to a legal page nobody opens. */}
        <s-text color="subdued">{t("settings.danger.uninstallPolicy")}</s-text>
      </s-stack>
    </s-section>
  );
}

import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type { ApplicationRowView, ApplicationsView } from "~/components/customers/types";

/**
 * The applications queue.
 *
 * Two rules shape this screen. A decision is never silent — every approval and
 * rejection writes an audit entry and records the email it sent. And a
 * rejection always carries a reason, because an applicant who asks "why?"
 * deserves an answer that somebody can actually give.
 */
export function ApplicationsPage({ view }: { view: ApplicationsView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("applications.heading")}>
      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href="/app/customers/applications" aria-current="page">
            {t("applications.tab")}
          </s-link>
          <s-link href="/app/customers">{t("customers.list.tabBuyers")}</s-link>
          <s-link href="/app/customers/groups">{t("customers.list.tabGroups")}</s-link>
          <s-link href="/app/customers/tagging">{t("customers.list.tabTagging")}</s-link>
        </s-stack>
      </s-section>

      <Banners view={view} />

      {view.editing ? <EditEmail view={view} /> : null}

      {view.loading ? (
        <Loading />
      ) : view.totalWaiting === 0 ? (
        <EmptyState view={view} />
      ) : (
        <s-section>
          <s-stack direction="block" gap="base">
            <form method="get">
              <s-search-field
                name="search"
                label={t("applications.searchLabel")}
                value={view.search}
              />
            </form>
            {view.rows.length === 0 ? (
              <NoResults />
            ) : (
              view.rows.map((row) => (
                <ApplicationCard key={row.id} row={row} view={view} />
              ))
            )}
            <Pagination view={view} />
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Banners({ view }: { view: ApplicationsView }) {
  const { t } = useTranslation();
  const banners: React.ReactNode[] = [];

  if (view.undo) {
    banners.push(
      // The checklist asks for a ten-second toast. This is the same promise
      // without JavaScript: a banner that says how long is left and a button
      // that does the taking back.
      <s-banner key="undo" tone="success">
        <s-heading>{t("applications.approvedHeading", { who: view.undo.who })}</s-heading>
        <s-paragraph>
          {t("applications.undoBody", { count: view.undo.secondsLeft })}
        </s-paragraph>
        <form method="post">
          <input type="hidden" name="intent" value="undo" />
          <input type="hidden" name="id" value={view.undo.id} />
          <s-button type="submit">{t("applications.undo")}</s-button>
        </form>
      </s-banner>,
    );
  }

  if (view.undoExpired) {
    banners.push(
      <s-banner key="undo-expired" tone="warning">
        <s-heading>{t("applications.undoExpiredHeading")}</s-heading>
        {/* Undo is not a decision; reversing one after the fact is, and it
            needs a reason like any other. */}
        <s-paragraph>{t("applications.undoExpiredBody")}</s-paragraph>
      </s-banner>,
    );
  }

  if (view.emailUnavailable) {
    banners.push(
      <s-banner key="email" tone="warning">
        <s-heading>{t("applications.noEmailHeading")}</s-heading>
        <s-paragraph>{t("applications.noEmailBody")}</s-paragraph>
      </s-banner>,
    );
  }

  if (banners.length === 0) return null;
  return <s-section>{banners}</s-section>;
}

function Loading() {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="small">
        <s-heading>{t("applications.loading")}</s-heading>
        {/* Three skeleton rows, as the checklist asks. Hidden from assistive
            tech: announcing three empty rows is worse than silence. */}
        <s-stack direction="block" gap="small" accessibilityVisibility="hidden">
          {[0, 1, 2].map((row) => (
            <s-box key={row} background="subdued" padding="base" borderRadius="base">
              <s-text color="subdued"> </s-text>
            </s-box>
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function EmptyState({ view }: { view: ApplicationsView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("applications.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">{t("applications.emptyBody")}</s-paragraph>
        {view.shareUrl ? (
          <s-stack direction="block" gap="small">
            <s-text-field
              label={t("applications.shareLabel")}
              value={view.shareUrl}
              readOnly
            />
            <s-link href={view.shareUrl}>{t("applications.openForm")}</s-link>
          </s-stack>
        ) : (
          // Nothing to share yet, so the empty state points at the thing that
          // has to exist first rather than at a link that does not.
          <s-button variant="primary" href="/app/forms">
            {t("applications.createForm")}
          </s-button>
        )}
      </s-stack>
    </s-section>
  );
}

function NoResults() {
  const { t } = useTranslation();
  return (
    <s-stack direction="block" gap="small">
      <s-heading>{t("applications.noResultsHeading")}</s-heading>
      <s-link href="?">{t("applications.clearSearch")}</s-link>
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */

function ApplicationCard({
  row,
  view,
}: {
  row: ApplicationRowView;
  view: ApplicationsView;
}) {
  const { t } = useTranslation();

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text type="strong">{row.company ?? row.contact}</s-text>
          <s-text color="subdued">{row.email}</s-text>
          <s-text color="subdued">
            {row.daysAgo === 0
              ? t("applications.today")
              : t("customers.list.daysAgo", { count: row.daysAgo })}
          </s-text>
          <s-badge tone="neutral">{row.formName}</s-badge>
        </s-stack>

        <s-stack direction="inline" gap="small-500" alignItems="center">
          <s-badge
            tone={
              row.vatStatus === "VALID"
                ? "success"
                : row.vatStatus === "INVALID"
                  ? "critical"
                  : "neutral"
            }
          >
            {t(`forms.vat.${row.vatStatus}`)}
          </s-badge>
          {row.vatNote ? (
            <s-text color="subdued">{t(`applications.vatNote.${row.vatNote}`)}</s-text>
          ) : null}
          {row.existingCustomer ? (
            // Approving will attach to the account they already have rather
            // than making a second one that splits their order history.
            <s-badge tone="info">{t("applications.existingCustomer")}</s-badge>
          ) : null}
          {row.sameDomainCount > 0 ? (
            <s-badge tone="caution">
              {t("applications.sameDomain", { count: row.sameDomainCount })}
            </s-badge>
          ) : null}
        </s-stack>

        <Screening row={row} view={view} />

        {row.uploads.length > 0 ? (
          <s-stack direction="inline" gap="small-500" alignItems="center">
            {row.uploads.map((upload) => (
              <s-stack
                key={upload.id}
                direction="inline"
                gap="small-500"
                alignItems="center"
              >
                <s-link href={`/app/forms/upload/${upload.id}`}>{upload.fileName}</s-link>
                {upload.scanned ? null : (
                  <s-badge tone="caution">{t("forms.publish.notScanned")}</s-badge>
                )}
              </s-stack>
            ))}
          </s-stack>
        ) : null}

        <ApproveForm row={row} view={view} />
        <NeedsInfoForm row={row} />
        <RejectForm row={row} view={view} />
      </s-stack>
    </s-box>
  );
}

/**
 * ✦ What Claude made of this application, and what the store's own criteria
 * make of it.
 *
 * Two verdicts, deliberately kept apart. The criteria are the merchant's own
 * rules and are the ones that can decide automatically; the screening is a
 * recommendation and decides nothing. Every state here leaves both buttons
 * live — including the two states that mean "we could not say".
 */
function Screening({ row, view }: { row: ApplicationRowView; view: ApplicationsView }) {
  return (
    <s-stack direction="block" gap="small-100">
      <AiScreening row={row} blockedBy={view.screeningBlockedBy} />
      <Criteria row={row} view={view} />
    </s-stack>
  );
}

const SCREENING_TONE = {
  recommend: "success",
  look: "warning",
  waiting: "info",
  unavailable: "info",
  off: "info",
} as const;

function AiScreening({
  row,
  blockedBy,
}: {
  row: ApplicationRowView;
  blockedBy: ApplicationsView["screeningBlockedBy"];
}) {
  const { t } = useTranslation();
  const { status, reasons } = row.screening;

  if (status === "waiting") {
    return (
      <s-banner tone="info">
        {/* A real state, not a spinner over a verdict: nothing has been asked
            yet, and the merchant can decide without waiting for it. */}
        <s-paragraph>{t("applications.screening.waiting")}</s-paragraph>
      </s-banner>
    );
  }

  if (status === "unavailable" || status === "off") {
    return (
      // Neutral on purpose: "could not screen" is not a warning about this
      // applicant, and it has never blocked approving anybody.
      <s-banner tone="info">
        <s-paragraph>
          {t(
            status === "off"
              ? `applications.screening.off.${blockedBy ?? "no_key"}`
              : "applications.screeningUnavailable",
          )}
        </s-paragraph>
      </s-banner>
    );
  }

  return (
    <s-banner tone={SCREENING_TONE[status]}>
      <s-heading>{t(`applications.screening.${status}`)}</s-heading>
      <s-unordered-list>
        {reasons.map((reason) => (
          <s-list-item key={reason.signal}>
            {/* Signal codes, not the model's prose: every reason renders from
                our own catalogue, in the merchant's language, and cannot be
                something Claude made up about a real business. */}
            {t(`applications.signal.${reason.signal}`, {
              count: reason.detail ?? 0,
              detail: reason.detail ?? "",
            })}
          </s-list-item>
        ))}
      </s-unordered-list>
      <s-paragraph color="subdued">{t("applications.screening.footnote")}</s-paragraph>
    </s-banner>
  );
}

/** What the store's own criteria make of this application. */
function Criteria({ row, view }: { row: ApplicationRowView; view: ApplicationsView }) {
  const { t } = useTranslation();

  if (!row.criteria) return null;

  return (
    <s-banner tone={row.criteria.met ? "success" : "warning"}>
      <s-heading>
        {row.criteria.met
          ? t("applications.criteriaMet")
          : t("applications.criteriaNotMet")}
      </s-heading>
      {/* The working, not just the verdict: a merchant cannot tell a good rule
          from one letting everybody through without seeing which line did it. */}
      <s-unordered-list>
        {row.criteria.reasons.map((reason) => (
          <s-list-item key={`${reason.field}-${reason.detail ?? ""}`}>
            <s-stack direction="inline" gap="small-500" alignItems="center">
              {/* Marked one by one. A list under "does not meet" that mixes
                  satisfied and unsatisfied lines without saying which is which
                  hides the one thing the merchant opened it to find. */}
              <s-badge tone={reason.met ? "success" : "critical"}>
                {t(reason.met ? "applications.reasonMet" : "applications.reasonUnmet")}
              </s-badge>
              <s-text>
                {t(
                  `applications.reason.${reason.met ? "met" : "unmet"}.${reason.field}`,
                  {
                    detail: reason.detail ?? "",
                    // Some of these sentences pluralise ("at least 2 years"),
                    // and i18next resolves a pluralised key only when handed a
                    // count — without one it falls back to the bare key and
                    // renders "applications.reason.met.years_in_business".
                    count: Number(reason.detail),
                  },
                )}
              </s-text>
            </s-stack>
          </s-list-item>
        ))}
      </s-unordered-list>
      {!view.aiScreening ? (
        <s-paragraph color="subdued">
          {t("applications.screeningUnavailable")}
        </s-paragraph>
      ) : null}
    </s-banner>
  );
}

function ApproveForm({ row, view }: { row: ApplicationRowView; view: ApplicationsView }) {
  const { t } = useTranslation();

  return (
    <form method="post">
      <input type="hidden" name="intent" value="approve" />
      <input type="hidden" name="id" value={row.id} />
      <s-stack direction="inline" gap="small" alignItems="end">
        {/* Group and terms in the same place, because they are one decision:
            the tier a buyer joins is what sets their payment terms. */}
        <s-select
          name="groupId"
          label={t("applications.groupLabel")}
          details={t("applications.groupHelp")}
          value=""
        >
          <s-option value="">{t("customers.list.noGroup")}</s-option>
          {view.groups.map((group) => (
            <s-option key={group.id} value={group.id}>
              {group.terms ? `${group.name} · ${group.terms}` : group.name}
            </s-option>
          ))}
        </s-select>
        <s-button type="submit" variant="primary">
          {t("applications.approve")}
        </s-button>
        <s-link href={`?edit=${row.id}&intent=approve`}>
          {t("applications.editEmail")}
        </s-link>
        {view.aiScreening ? (
          <s-link href={`?edit=${row.id}&intent=approve&draft=1`}>
            {t("applications.draftEmail")}
          </s-link>
        ) : null}
      </s-stack>
    </form>
  );
}

/**
 * Ask the applicant for something, and leave them in the queue.
 *
 * The third option, and the one that keeps a good buyer who filled the form in
 * badly. An application that left the queue while it waited for a reply is one
 * nobody comes back to, so this does not change its status.
 */
function NeedsInfoForm({ row }: { row: ApplicationRowView }) {
  const { t } = useTranslation();

  return (
    <form method="post">
      <input type="hidden" name="intent" value="needsInfo" />
      <input type="hidden" name="id" value={row.id} />
      <s-stack direction="inline" gap="small" alignItems="end">
        <s-text-field
          name="note"
          label={t("applications.needsInfoLabel")}
          details={t("applications.needsInfoHelp")}
        />
        <s-button type="submit" variant="tertiary">
          {t("applications.needsInfo")}
        </s-button>
      </s-stack>
    </form>
  );
}

function RejectForm({ row, view }: { row: ApplicationRowView; view: ApplicationsView }) {
  const { t } = useTranslation();

  return (
    <form method="post">
      <input type="hidden" name="intent" value="reject" />
      <input type="hidden" name="id" value={row.id} />
      <s-stack direction="inline" gap="small" alignItems="end">
        <s-select
          name="reason"
          label={t("applications.reasonLabel")}
          details={t("applications.reasonHelp")}
          value=""
        >
          {/* No blank option: a rejection nobody gave a reason for is one
              nobody can answer for. */}
          {view.rejectionReasons.map((reason) => (
            <s-option key={reason} value={reason}>
              {t(`applications.rejection.${reason}`)}
            </s-option>
          ))}
        </s-select>
        <s-text-field name="note" label={t("applications.noteLabel")} />
        <s-checkbox
          name="blockDomain"
          value="yes"
          label={t("applications.blockDomain", { domain: domainOf(row.email) })}
        />
        <s-button type="submit" tone="critical">
          {t("applications.reject")}
        </s-button>
        <s-link href={`?edit=${row.id}&intent=reject`}>
          {t("applications.editEmail")}
        </s-link>
        {/* A link, not a second submit: a Polaris button carries no name, so
            one form is one intent. The draft opens the same panel, filled in. */}
        {view.aiScreening ? (
          <s-link href={`?edit=${row.id}&intent=reject&draft=1`}>
            {t("applications.draftEmail")}
          </s-link>
        ) : null}
      </s-stack>
    </form>
  );
}

/** The domain part, for the "block this domain" label. */
function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? email : email.slice(at + 1);
}

/* -------------------------------------------------------------------------- */

function EditEmail({ view }: { view: ApplicationsView }) {
  const { t } = useTranslation();
  const editing = view.editing!;

  return (
    <s-section heading={t(`applications.editEmailHeading.${editing.intent}`)}>
      <form method="post">
        <input type="hidden" name="intent" value={editing.intent} />
        <input type="hidden" name="id" value={editing.id} />
        <input type="hidden" name="customEmail" value="yes" />
        <s-stack direction="block" gap="small">
          {view.emailDraft.drafted ? (
            // brand.md §5, near enough verbatim. The merchant is about to send
            // this to a real person under their own name.
            <s-banner tone="info">
              <s-paragraph>{t("applications.draftedByClaude")}</s-paragraph>
            </s-banner>
          ) : null}
          {view.emailDraft.failure ? (
            <s-banner tone="warning">
              <s-paragraph>
                {t(`applications.draftFailed.${view.emailDraft.failure}`)}
              </s-paragraph>
            </s-banner>
          ) : null}
          <s-text-field
            name="emailSubject"
            label={t("forms.emails.subject")}
            value={editing.subject}
          />
          <s-text-area
            name="emailBody"
            label={t("forms.emails.body")}
            value={editing.body}
          />
          {editing.intent === "approve" ? (
            <s-select name="groupId" label={t("applications.groupLabel")} value="">
              <s-option value="">{t("customers.list.noGroup")}</s-option>
              {view.groups.map((group) => (
                <s-option key={group.id} value={group.id}>
                  {group.name}
                </s-option>
              ))}
            </s-select>
          ) : (
            <s-select
              name="reason"
              label={t("applications.reasonLabel")}
              value={editing.reason || view.rejectionReasons[0]}
            >
              {view.rejectionReasons.map((reason) => (
                <s-option key={reason} value={reason}>
                  {t(`applications.rejection.${reason}`)}
                </s-option>
              ))}
            </s-select>
          )}
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-button
              type="submit"
              variant="primary"
              {...whenDisabled(view.emailUnavailable)}
            >
              {t(`applications.sendAnd.${editing.intent}`)}
            </s-button>
            <s-link href="?">{t("applications.cancelEdit")}</s-link>
          </s-stack>
        </s-stack>
      </form>
    </s-section>
  );
}

function Pagination({ view }: { view: ApplicationsView }) {
  const { t } = useTranslation();
  if (view.total <= view.pageSize) return null;

  const from = (view.page - 1) * view.pageSize + 1;
  const to = Math.min(view.page * view.pageSize, view.total);
  const link = (page: number) =>
    `?${new URLSearchParams({
      ...(view.search ? { search: view.search } : {}),
      page: String(page),
    }).toString()}`;

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {view.page > 1 ? (
        <s-link href={link(view.page - 1)}>{t("customers.list.previous")}</s-link>
      ) : null}
      <s-text color="subdued" fontVariantNumeric="tabular-nums">
        {t("customers.list.showing", { from, to, total: view.total })}
      </s-text>
      {to < view.total ? (
        <s-link href={link(view.page + 1)}>{t("customers.list.next")}</s-link>
      ) : null}
    </s-stack>
  );
}

import { useTranslation } from "react-i18next";

import { whenChecked, whenDisabled } from "~/components/boolean-attribute";
import type { TranslationsView } from "~/components/settings/types";
import { MAX_IMPORT_BYTES } from "~/lib/i18n/limits";

/**
 * The strings a buyer reads, in the merchant's own words.
 *
 * Its own page rather than a card in Settings: five hundred rows is a page,
 * and a table with a search, three filters and pagination inside an accordion
 * beside the danger zone would be a worse version of both.
 *
 * Every row says who wrote it. A string ✦ suggested is marked as suggested
 * until a person says otherwise — that is the whole of Invariant 3 for this
 * feature, and the reason the fill is safe to offer at all.
 */
export function TranslationsPage({ view }: { view: TranslationsView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("translations.heading")}>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-link href="/app/settings">{t("translations.backToSettings")}</s-link>
          <s-paragraph color="subdued">{t("translations.body")}</s-paragraph>

          {/* The theme's own headings are not here on purpose, and saying so
              is cheaper than a merchant hunting for them. */}
          <s-text color="subdued">{t("translations.notHere")}</s-text>
        </s-stack>
      </s-section>

      <s-section heading={t("translations.filtersHeading")}>
        <form method="get">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-select
              name="locale"
              label={t("translations.languageLabel")}
              value={view.locale}
            >
              {view.locales.map((locale) => (
                <s-option key={locale.code} value={locale.code}>
                  {locale.name}
                </s-option>
              ))}
            </s-select>
            <s-search-field
              name="search"
              label={t("translations.searchLabel")}
              value={view.search}
            />
            <s-checkbox
              name="unwritten"
              value="on"
              label={t("translations.unwrittenOnly")}
              {...whenChecked(view.unwrittenOnly)}
            />
            <s-checkbox
              name="review"
              value="on"
              label={t("translations.reviewOnly")}
              {...whenChecked(view.reviewOnly)}
            />
            <s-button type="submit">{t("translations.apply")}</s-button>
          </s-stack>
        </form>
      </s-section>

      <Fill view={view} />

      <s-section heading={t("translations.tableHeading", { count: view.total })}>
        {view.rows.length === 0 ? (
          <s-paragraph>
            {t(view.filtered ? "translations.emptyFiltered" : "translations.emptyAll")}
          </s-paragraph>
        ) : (
          /* One form for the whole page, with the contextual save bar.
             Per-row forms meant a merchant who edited five rows and pressed
             Save on one lost the other four, silently — and a page built for
             bulk editing is exactly where that happens. */
          <form method="post" data-save-bar>
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="locale" value={view.locale} />

            <s-stack direction="block" gap="base">
              {view.rows.map((row) => (
                <s-box
                  key={row.key}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  {/* What this row said when the page was drawn, so the action
                      can tell an edit from a row nobody touched — and leave the
                      untouched ones as Mannon's rather than adopting all 51. */}
                  <input type="hidden" name={`was:${row.key}`} value={row.value ?? ""} />

                  <s-stack direction="block" gap="small-100">
                    <s-stack direction="inline" gap="small" alignItems="center">
                      {/* The key is shown as itself, and says so: the capture
                          guard treats visible catalog keys as a leaked i18n
                          fallback everywhere except here, where showing them
                          is the point. */}
                      <s-text type="strong" data-string-key={row.key}>
                        {row.key}
                      </s-text>
                      {/* Who wrote this. A suggestion a merchant cannot tell
                          from their own words is a suggestion they cannot
                          decide about. */}
                      {row.needsReview ? (
                        <s-badge tone="warning">{t("translations.suggested")}</s-badge>
                      ) : row.value !== null ? (
                        <s-badge tone="success">{t("translations.yours")}</s-badge>
                      ) : (
                        <s-badge tone="neutral">{t("translations.shipped")}</s-badge>
                      )}
                    </s-stack>

                    <s-text color="subdued">
                      {row.shipped === ""
                        ? t("translations.noShipped")
                        : t("translations.shippedAs", { text: row.shipped })}
                    </s-text>

                    <s-text-area
                      name={`value:${row.key}`}
                      label={t("translations.yourWordingLabel")}
                      details={
                        row.placeholders.length > 0
                          ? t("translations.placeholderHelp", {
                              // Braces and all: a merchant retyping this has
                              // to produce `{{days}}`, not `days`.
                              tags: row.placeholders
                                .map((tag) => `{{${tag}}}`)
                                .join(", "),
                            })
                          : t("translations.clearHelp")
                      }
                      value={row.value ?? ""}
                      {...(row.error ? { error: row.error } : {})}
                    />

                    {/* Accepting is part of the same Save rather than a second
                        form: a `<form>` inside a `<form>` is folded by the
                        parser and its fields join the outer one, which is how
                        6.4 shipped a section that could not be saved at all. */}
                    {row.needsReview ? (
                      <s-checkbox
                        name={`accept:${row.key}`}
                        value="on"
                        label={t("translations.accept")}
                        details={t("translations.acceptHelp")}
                      />
                    ) : null}
                  </s-stack>
                </s-box>
              ))}

              <s-button type="submit" variant="primary">
                {t("translations.save")}
              </s-button>

              <s-stack direction="inline" gap="small" alignItems="center">
                {view.previousHref ? (
                  <s-link href={view.previousHref}>{t("translations.newer")}</s-link>
                ) : null}
                <s-text color="subdued">
                  {t("translations.page", { page: view.page, pages: view.pages })}
                </s-text>
                {view.nextHref ? (
                  <s-link href={view.nextHref}>{t("translations.older")}</s-link>
                ) : null}
              </s-stack>
            </s-stack>
          </form>
        )}
      </s-section>

      <s-section heading={t("translations.exportHeading")}>
        <s-stack direction="block" gap="small">
          <s-paragraph color="subdued">{t("translations.exportBody")}</s-paragraph>
          <s-link href={`/app/settings/translations/export?locale=${view.locale}`}>
            {t("translations.exportLink")}
          </s-link>
        </s-stack>
      </s-section>

      <Import view={view} />
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The same file back again, and what it did — string by string.
 *
 * A merchant with five hundred rows edits them in a spreadsheet or sends them
 * to a translator, so the file has to come back. What it did has to be said in
 * full: a file whose wording was quietly refused, under a heading that says
 * "imported", is the merchant finding out from a buyer.
 */
function Import({ view }: { view: TranslationsView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("translations.importHeading")}>
      <s-stack direction="block" gap="small">
        <s-paragraph color="subdued">{t("translations.importBody")}</s-paragraph>

        {view.importIssue ? (
          <s-banner tone="critical">
            <s-paragraph>
              {t(`translations.importIssue.${view.importIssue}`, {
                megabytes: Math.floor(MAX_IMPORT_BYTES / (1024 * 1024)),
              })}
            </s-paragraph>
          </s-banner>
        ) : null}

        {view.imported ? (
          <s-banner tone={view.imported.rejected.length > 0 ? "warning" : "success"}>
            <s-stack direction="block" gap="small-500">
              <s-paragraph>
                {t("translations.imported", { count: view.imported.applied })}
              </s-paragraph>
              {view.imported.unchanged > 0 ? (
                <s-paragraph>
                  {t("translations.importUnchanged", {
                    count: view.imported.unchanged,
                  })}
                </s-paragraph>
              ) : null}
              {view.imported.rejected.length > 0 ? (
                <>
                  <s-paragraph>
                    {t("translations.importRefused", {
                      count: view.imported.rejected.length,
                    })}
                  </s-paragraph>
                  <s-unordered-list>
                    {view.imported.rejected.map((one) => (
                      <s-list-item key={one.key}>
                        <s-text data-string-key={one.key}>{one.key}</s-text>
                        <s-text color="subdued">
                          {` — ${t(`translations.importReason.${one.reason}`)}`}
                        </s-text>
                      </s-list-item>
                    ))}
                  </s-unordered-list>
                </>
              ) : null}
            </s-stack>
          </s-banner>
        ) : null}

        <form method="post" encType="multipart/form-data">
          <input type="hidden" name="intent" value="import" />
          <input type="hidden" name="locale" value={view.locale} />
          <s-stack direction="block" gap="small">
            <label htmlFor="translations-import-file">
              <s-text>{t("translations.importFileLabel")}</s-text>
            </label>
            <input
              id="translations-import-file"
              type="file"
              name="file"
              accept="application/json,.json"
              required
            />
            <s-text color="subdued">{t("translations.importFileHelp")}</s-text>
            <s-button type="submit">{t("translations.import")}</s-button>
          </s-stack>
        </form>
      </s-stack>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */

/** ✦ Fill what this language is missing, and say what that will do. */
function Fill({ view }: { view: TranslationsView }) {
  const { t } = useTranslation();
  const { fill } = view;

  return (
    <s-section heading={t("translations.fillHeading")}>
      <s-stack direction="block" gap="small">
        {fill.locked ? (
          <s-banner tone="info">
            <s-paragraph>
              {t(`translations.fillLocked.${fill.locked}`, { plan: fill.requiredPlan })}
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-paragraph color="subdued">
          {fill.pending === 0
            ? t("translations.nothingPending")
            : t("translations.pendingCount", { count: fill.pending })}
        </s-paragraph>

        {/* Said before it runs, not after: a merchant deciding whether to press
            this needs to know the result arrives as a suggestion. */}
        <s-text color="subdued">{t("translations.fillPromise")}</s-text>

        {fill.failure ? (
          <s-banner tone="warning">
            {/* This page's own copy, not the Buyer Agent's: "so the agent
                can't answer" and "Nothing was sent" are about a conversation
                with a buyer, and neither is what happened here. */}
            <s-paragraph>{t(`translations.fillFailure.${fill.failure}`)}</s-paragraph>
          </s-banner>
        ) : null}
        {fill.filled > 0 ? (
          <s-banner tone="success">
            <s-paragraph>{t("translations.filled", { count: fill.filled })}</s-paragraph>
          </s-banner>
        ) : null}

        <form method="post">
          <input type="hidden" name="intent" value="fill" />
          <input type="hidden" name="locale" value={view.locale} />
          <s-button
            type="submit"
            {...whenDisabled(fill.locked !== null || fill.pending === 0 || fill.running)}
          >
            {t(fill.running ? "translations.filling" : "translations.fill")}
          </s-button>
        </form>
      </s-stack>
    </s-section>
  );
}

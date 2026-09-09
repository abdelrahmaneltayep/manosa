import { useTranslation } from "react-i18next";

import type { ImportIssue, ImportWarning } from "~/lib/pricing/csv/plan";
import { TEMPLATE_KEYS, type TemplateKey } from "~/lib/pricing/csv/templates";

const whenDisabled = (value: boolean) => (value ? { disabled: true } : {});

export type CsvStep = "choose" | "review" | "imported" | "undone";

export interface CsvView {
  step: CsvStep;
  /** Set when the file could not even be read. */
  fileError:
    | { code: "too_large"; sizeMb: number }
    | { code: "too_many_rows"; rows: number; limit: number }
    | { code: "unreadable"; detail: string }
    | { code: "unknown_template" }
    | null;
  review: {
    fileName: string;
    template: TemplateKey;
    /** Header → matched field, or null when ignored. */
    columns: { header: string; matched: boolean }[];
    totalRows: number;
    willCreate: number;
    errors: ImportIssue[];
    warnings: ImportWarning[];
    /** Set when importing would produce a ruleset checkout cannot accept. */
    tooLarge: { bytes: number; limit: number } | null;
    /** The held upload, so confirming imports exactly what was checked. */
    draftId: string;
  } | null;
  imported: { count: number; importId: string } | null;
  undone: { count: number } | null;
  undoExpired: boolean;
}

export function CsvPage({ view }: { view: CsvView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("csv.heading")}>
      <Outcome view={view} />
      {view.step === "review" && view.review ? (
        <Review view={view} />
      ) : view.step === "choose" ? (
        <>
          <FileError view={view} />
          <Upload />
          <Templates />
        </>
      ) : null}
    </s-page>
  );
}

function Outcome({ view }: { view: CsvView }) {
  const { t } = useTranslation();

  if (view.undone) {
    return (
      <s-section>
        <s-banner tone="success">
          <s-heading>{t("csv.undoneHeading")}</s-heading>
          <s-paragraph>{t("csv.undoneBody", { count: view.undone.count })}</s-paragraph>
        </s-banner>
      </s-section>
    );
  }

  if (view.undoExpired) {
    return (
      <s-section>
        <s-banner tone="warning">
          <s-heading>{t("csv.undoExpiredHeading")}</s-heading>
          <s-paragraph>{t("csv.undoExpiredBody")}</s-paragraph>
        </s-banner>
      </s-section>
    );
  }

  if (!view.imported) return null;

  return (
    <s-section>
      <s-banner tone="success">
        <s-heading>{t("csv.importedHeading", { count: view.imported.count })}</s-heading>
        <s-paragraph>{t("csv.importedBody")}</s-paragraph>
        {/* One click, for the next hour. A merchant who imported the wrong
            file should not have to delete two hundred rules by hand. */}
        <form method="post">
          <input type="hidden" name="intent" value="undo" />
          <input type="hidden" name="importId" value={view.imported.importId} />
          <s-button type="submit">{t("csv.undo")}</s-button>
        </form>
        <s-link href="/app/pricing">{t("pricing.list.heading")}</s-link>
      </s-banner>
    </s-section>
  );
}

function FileError({ view }: { view: CsvView }) {
  const { t } = useTranslation();
  if (!view.fileError) return null;

  const error = view.fileError;
  const [heading, body] =
    error.code === "too_large"
      ? [t("csv.fileTooLargeHeading"), t("csv.fileTooLargeBody", { size: error.sizeMb })]
      : error.code === "too_many_rows"
        ? [
            t("csv.tooManyRowsHeading"),
            t("csv.tooManyRowsBody", { rows: error.rows, limit: error.limit }),
          ]
        : error.code === "unknown_template"
          ? [t("csv.unknownTemplateHeading"), t("csv.unknownTemplateBody")]
          : [t("csv.unreadableHeading"), error.detail];

  return (
    <s-section>
      <s-banner tone="critical">
        <s-heading>{heading}</s-heading>
        <s-paragraph>{body}</s-paragraph>
      </s-banner>
    </s-section>
  );
}

function Upload() {
  const { t } = useTranslation();

  return (
    <s-section heading={t("csv.importHeading")}>
      <form method="post" encType="multipart/form-data">
        <input type="hidden" name="intent" value="review" />
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">{t("csv.dropzoneHelp")}</s-paragraph>
          {/* A plain file input: it works without JavaScript, and a merchant on
              a phone gets their own file picker. */}
          <input type="file" name="file" accept=".csv,text/csv" required />
          <s-button type="submit" variant="primary">
            {t("csv.upload")}
          </s-button>
        </s-stack>
      </form>
    </s-section>
  );
}

function Templates() {
  const { t } = useTranslation();

  return (
    <s-section heading={t("csv.templateHeading")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">{t("csv.templateBody")}</s-paragraph>
        {TEMPLATE_KEYS.map((key) => (
          <s-stack key={key} direction="inline" gap="small" alignItems="center">
            <s-text type="strong">
              {t(
                `csv.template.${key === "quantity_breaks" ? "quantityBreaks" : "rules"}`,
              )}
            </s-text>
            <s-link href={`?download=template&template=${key}`}>
              {t("csv.downloadTemplate")}
            </s-link>
            <s-link href={`?download=export&template=${key}`}>
              {t("csv.downloadExport")}
            </s-link>
          </s-stack>
        ))}
      </s-stack>
    </s-section>
  );
}

function Review({ view }: { view: CsvView }) {
  const { t } = useTranslation();
  const review = view.review!;
  const blocked = review.willCreate === 0 || review.tooLarge !== null;

  return (
    <>
      <s-section heading={t("csv.dryRunHeading")}>
        <s-stack direction="block" gap="base">
          <s-text type="strong">{review.fileName}</s-text>

          {review.tooLarge ? (
            <s-banner tone="critical">
              <s-heading>{t("csv.tooLargeHeading")}</s-heading>
              <s-paragraph>
                {t("csv.tooLargeBody", {
                  bytes: Math.ceil(review.tooLarge.bytes / 1024),
                  limit: Math.floor(review.tooLarge.limit / 1024),
                })}
              </s-paragraph>
            </s-banner>
          ) : null}

          {/* The count first, in plain words: "214 will import, 6 errors". */}
          <s-stack direction="block" gap="small-500">
            <s-text>{t("csv.willImport", { count: review.willCreate })}</s-text>
            {review.errors.length > 0 ? (
              <s-text tone="critical">
                {t("csv.withErrors", { count: review.errors.length })}
              </s-text>
            ) : null}
            {review.warnings.length > 0 ? (
              <s-text tone="caution">
                {t("csv.withWarnings", { count: review.warnings.length })}
              </s-text>
            ) : null}
          </s-stack>

          {review.willCreate === 0 && !review.tooLarge ? (
            <s-paragraph tone="critical">{t("csv.nothingToImport")}</s-paragraph>
          ) : null}

          <s-stack direction="inline" gap="small">
            <form method="post">
              <input type="hidden" name="intent" value="confirm" />
              <input type="hidden" name="draftId" value={review.draftId} />
              <s-button type="submit" variant="primary" {...whenDisabled(blocked)}>
                {t("csv.confirmImport", { count: review.willCreate })}
              </s-button>
            </form>
            {review.errors.length + review.warnings.length > 0 ? (
              <form method="post">
                <input type="hidden" name="intent" value="errors" />
                <input type="hidden" name="draftId" value={review.draftId} />
                <s-button type="submit">{t("csv.downloadErrors")}</s-button>
              </form>
            ) : null}
            <s-link href="?">{t("csv.cancel")}</s-link>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading={t("csv.mappingHeading")}>
        <s-stack direction="block" gap="small">
          <s-paragraph color="subdued">{t("csv.mappingBody")}</s-paragraph>
          <s-stack direction="inline" gap="small">
            {review.columns.map((column) => (
              <s-badge key={column.header} tone={column.matched ? "success" : "neutral"}>
                {column.header} ·{" "}
                {column.matched ? t("csv.mappingMatched") : t("csv.mappingIgnored")}
              </s-badge>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      {review.errors.length + review.warnings.length > 0 ? (
        <Problems view={view} />
      ) : null}
    </>
  );
}

/**
 * Every problem, with its line number.
 *
 * Listed rather than counted: an unknown SKU that is only counted is a price
 * that quietly does not apply, and the merchant finds out from a buyer.
 */
function Problems({ view }: { view: CsvView }) {
  const { t } = useTranslation();
  const review = view.review!;

  const rows = [
    ...review.errors.map((issue) => ({
      line: issue.line,
      column: issue.column ?? "",
      critical: true,
      text: t(`csv.issue.${issue.code}`, issue.params ?? {}),
    })),
    ...review.warnings.map((warning) => ({
      line: warning.line ?? 0,
      column: "",
      critical: false,
      text: t(`csv.warning.${warning.code}`, warning.params ?? {}),
    })),
  ].sort((a, b) => a.line - b.line);

  return (
    <s-section heading={t("csv.problemsHeading")}>
      <s-table>
        <s-table-header-row>
          <s-table-header>{t("csv.colLine")}</s-table-header>
          <s-table-header>{t("csv.colColumn")}</s-table-header>
          <s-table-header>{t("csv.colProblem")}</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((row, index) => (
            <s-table-row key={index}>
              <s-table-cell>
                <s-text fontVariantNumeric="tabular-nums">{row.line || ""}</s-text>
              </s-table-cell>
              <s-table-cell>{row.column}</s-table-cell>
              <s-table-cell>
                <s-text tone={row.critical ? "critical" : "caution"}>{row.text}</s-text>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}

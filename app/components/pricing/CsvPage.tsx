import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";

import type { ImportIssue, ImportWarning } from "~/lib/pricing/csv/plan";
import { TEMPLATE_KEYS, type TemplateKey } from "~/lib/pricing/csv/templates";

export type CsvStep = "choose" | "map" | "review" | "imported" | "undone";

export interface ColumnMapRowView {
  header: string;
  /** The template column it is mapped to, or "" for "ignore this column". */
  column: string;
  confidence: "high" | "medium" | "low";
  /** A few values from the file, so a mapping can be checked rather than trusted. */
  samples: string[];
}

export interface MappingView {
  draftId: string;
  fileName: string;
  template: TemplateKey;
  rows: ColumnMapRowView[];
  /** The columns this template wants, and which of them are required. */
  targets: { key: string; required: boolean }[];
  /** What Claude said it was unsure about. Shown, never acted on. */
  notes: string | null;
  /** Set when Claude could not map it — the merchant maps it themselves. */
  aiFailure: string | null;
  /** Required columns nothing is mapped to. Importing would fail on them. */
  missingRequired: string[];
}

export interface CsvView {
  step: CsvStep;
  /** ✦ The mapping screen, for a file whose headers matched no template. */
  mapping: MappingView | null;
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
      {view.step === "map" && view.mapping ? (
        <Mapping view={view} />
      ) : view.step === "review" && view.review ? (
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

/**
 * ✦ The mapping screen.
 *
 * A file whose headers matched no template used to be refused. Now Claude
 * proposes what each column is, with how sure it is, and the merchant fixes any
 * of it before a single row is planned. Nothing is imported from this screen —
 * confirming it produces the same dry-run report every other file gets.
 */
function Mapping({ view }: { view: CsvView }) {
  const { t } = useTranslation();
  const mapping = view.mapping!;

  return (
    <s-section heading={t("csv.map.heading")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">
          {t("csv.map.body", { file: mapping.fileName })}
        </s-paragraph>

        {mapping.aiFailure ? (
          <s-banner tone="warning">
            <s-heading>{t(`csv.map.failure.${mapping.aiFailure}Heading`)}</s-heading>
            <s-paragraph>{t("csv.map.failureBody")}</s-paragraph>
          </s-banner>
        ) : null}

        {mapping.notes ? (
          <s-banner tone="info">
            <s-paragraph>{mapping.notes}</s-paragraph>
          </s-banner>
        ) : null}

        {mapping.missingRequired.length > 0 ? (
          <s-banner tone="critical">
            <s-heading>
              {t("csv.map.missingHeading", { count: mapping.missingRequired.length })}
            </s-heading>
            <s-paragraph>
              {t("csv.map.missingBody", {
                columns: mapping.missingRequired
                  .map((key) => t(`csv.column.${camel(key)}`))
                  .join(", "),
              })}
            </s-paragraph>
          </s-banner>
        ) : null}

        <form method="post">
          <input type="hidden" name="intent" value="map" />
          <input type="hidden" name="draftId" value={mapping.draftId} />
          <input type="hidden" name="template" value={mapping.template} />
          <s-stack direction="block" gap="small">
            {mapping.rows.map((row) => (
              <s-stack key={row.header} direction="inline" gap="small" alignItems="end">
                <s-select
                  name={`column:${row.header}`}
                  label={row.header}
                  details={
                    row.samples.length > 0
                      ? t("csv.map.samples", { values: row.samples.join(", ") })
                      : t("csv.map.noSamples")
                  }
                  value={row.column}
                >
                  <s-option value="">{t("csv.map.ignore")}</s-option>
                  {mapping.targets.map((target) => (
                    <s-option key={target.key} value={target.key}>
                      {t(`csv.column.${camel(target.key)}`)}
                    </s-option>
                  ))}
                </s-select>
                {/* How sure Claude was, per column. A mapping the merchant is
                    asked to trust without being told how firm it is, is a
                    mapping they will not check. */}
                <s-badge tone={CONFIDENCE_TONE[row.confidence]}>
                  {t(`csv.map.confidence.${row.confidence}`)}
                </s-badge>
              </s-stack>
            ))}
            <s-button type="submit" variant="primary">
              {t("csv.map.continue")}
            </s-button>
          </s-stack>
        </form>
      </s-stack>
    </s-section>
  );
}

const CONFIDENCE_TONE = {
  high: "success",
  medium: "warning",
  low: "critical",
} as const;

/** `rule_name` → `ruleName`, which is how the column labels are keyed. */
function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
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

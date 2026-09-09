import { useTranslation } from "react-i18next";

import type { Appearance } from "~/lib/forms/appearance";
import { FONT_STACKS } from "~/lib/forms/appearance";
import { issueMessage, uploadLimitMegabytes } from "~/lib/forms/issue-message";
import type { FormField, SubmissionIssue } from "~/lib/forms/schema";
import { HONEYPOT_FIELD, RENDERED_AT_FIELD } from "~/lib/forms/spam";

/**
 * The form a buyer fills in.
 *
 * Plain HTML with inline styles, not Polaris: this renders on the merchant's
 * storefront domain and inside their theme, where Polaris does not exist and
 * should not.
 *
 * It works with JavaScript switched off. That is not a nicety — it is a real
 * form on a real storefront, and the state a buyer meets most often is the one
 * before any script has run. Server-side validation resolves conditional
 * visibility from the answers, so a field that JS would have hidden is simply
 * not required rather than being a blocker nobody can see.
 */

export interface PublicFormView {
  action: string;
  name: string;
  intro?: string | null;
  fields: FormField[];
  appearance: Appearance;
  answers: Record<string, string>;
  issues: SubmissionIssue[];
  /** Milliseconds since the epoch, stamped when the page was rendered. */
  renderedAt: number;
  dir: "ltr" | "rtl";
}

const inputStyle = (appearance: Appearance): React.CSSProperties => ({
  width: "100%",
  boxSizing: "border-box",
  padding: "0.6rem 0.7rem",
  border: "1px solid #c9c9c9",
  borderRadius: "6px",
  font: "inherit",
  color: appearance.text,
  background: "#fff",
});

const errorStyle: React.CSSProperties = {
  color: "#b3231f",
  fontSize: "0.85em",
  marginTop: "0.25rem",
};

export function PublicForm({ view }: { view: PublicFormView }) {
  const { t } = useTranslation();
  const { appearance } = view;
  const byKey = new Map(view.fields.map((field) => [field.key, field]));
  const issuesByKey = new Map(view.issues.map((issue) => [issue.key, issue]));

  return (
    <div
      style={{
        maxWidth: `${appearance.width}px`,
        margin: "0 auto",
        padding: appearance.layout === "boxed" ? "2rem" : "1rem 0",
        background: appearance.layout === "boxed" ? appearance.background : "transparent",
        border: appearance.layout === "boxed" ? "1px solid #e3e3e3" : "none",
        borderRadius: appearance.layout === "boxed" ? "12px" : 0,
        color: appearance.text,
        fontFamily: FONT_STACKS[appearance.font],
      }}
    >
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>{view.name}</h1>
      {view.intro ? <p style={{ marginTop: 0 }}>{view.intro}</p> : null}

      {view.issues.length > 0 ? (
        // A summary at the top, linked to each field. Without it, a buyer on a
        // long form gets a page that reloaded for no visible reason.
        <div
          role="alert"
          tabIndex={-1}
          id="form-errors"
          style={{
            border: "1px solid #b3231f",
            background: "#fdeaea",
            borderRadius: "8px",
            padding: "0.75rem 1rem",
            marginBottom: "1rem",
          }}
        >
          <strong>{t("forms.public.errorSummary")}</strong>
          <ul style={{ margin: "0.5rem 0 0", paddingInlineStart: "1.1rem" }}>
            {view.issues.map((issue) => (
              <li key={`${issue.key}-${issue.code}`}>
                <a href={`#field-${issue.key}`} style={{ color: "#b3231f" }}>
                  {issueMessage(issue, byKey.get(issue.key), t)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form method="post" action={view.action} encType="multipart/form-data" noValidate>
        <input type="hidden" name={RENDERED_AT_FIELD} value={String(view.renderedAt)} />
        {/* The honeypot. Hidden from people and from screen readers, left in
            the DOM for anything that fills in every input it finds.

            Clipped rather than pushed off-screen: `left: -9999px` overflows
            the document in a right-to-left layout, which gave the Arabic form
            an eleven-thousand-pixel horizontal scrollbar. Clipping is
            direction-agnostic and creates no scrollable area at all. */}
        <div
          style={{
            position: "absolute",
            width: "1px",
            height: "1px",
            overflow: "hidden",
            clipPath: "inset(50%)",
            whiteSpace: "nowrap",
          }}
          aria-hidden="true"
        >
          <label htmlFor={HONEYPOT_FIELD}>Website</label>
          <input
            type="text"
            id={HONEYPOT_FIELD}
            name={HONEYPOT_FIELD}
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        {view.fields.map((field) => (
          <Field
            key={field.key}
            field={field}
            view={view}
            issue={issuesByKey.get(field.key)}
          />
        ))}

        <button
          type="submit"
          style={{
            marginTop: "1rem",
            padding: "0.7rem 1.4rem",
            border: "none",
            borderRadius: "8px",
            background: appearance.accent,
            color: appearance.accentText,
            font: "inherit",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t("forms.public.submit")}
        </button>
      </form>
    </div>
  );
}

function Field({
  field,
  view,
  issue,
}: {
  field: FormField;
  view: PublicFormView;
  issue: SubmissionIssue | undefined;
}) {
  const { t } = useTranslation();
  const { appearance } = view;
  const value = view.answers[field.key] ?? "";
  const id = `field-${field.key}`;
  const describedBy = [field.help ? `${id}-help` : null, issue ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");

  const shared = {
    id,
    name: field.key,
    ...(field.required ? { "aria-required": true } : {}),
    ...(issue ? { "aria-invalid": true } : {}),
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    style: inputStyle(appearance),
  };

  const label = (
    <label
      htmlFor={id}
      style={{ display: "block", fontWeight: 600, marginBottom: ".2rem" }}
    >
      {field.label}{" "}
      <span style={{ fontWeight: 400, opacity: 0.7 }}>
        {field.required ? t("forms.public.required") : t("forms.public.optional")}
      </span>
    </label>
  );

  const help = field.help ? (
    <p id={`${id}-help`} style={{ fontSize: ".85em", opacity: 0.75, margin: ".2rem 0" }}>
      {field.help}
    </p>
  ) : null;

  const error = issue ? (
    <p id={`${id}-error`} style={errorStyle}>
      {issueMessage(issue, field, t)}
    </p>
  ) : null;

  // A conditional field is rendered, always. Hiding it needs JavaScript, and
  // the server does not require an answer to a field its condition excludes —
  // so showing it costs an unnecessary question, while hiding it without JS
  // would cost the applicant a field they can never fill in.
  const conditional = field.showWhen
    ? {
        "data-show-when-field": field.showWhen.field,
        "data-show-when-equals": field.showWhen.equals,
      }
    : {};

  return (
    <div style={{ marginBottom: "1rem" }} {...conditional}>
      {field.kind === "checkbox" || field.kind === "privacy" ? (
        <>
          <label
            htmlFor={id}
            style={{ display: "flex", gap: ".5rem", alignItems: "start" }}
          >
            <input
              type="checkbox"
              id={id}
              name={field.key}
              value="yes"
              defaultChecked={value === "yes"}
              {...(field.required ? { "aria-required": true } : {})}
              {...(issue ? { "aria-invalid": true } : {})}
              {...(describedBy ? { "aria-describedby": describedBy } : {})}
            />
            <span>{field.label}</span>
          </label>
          {help}
          {error}
        </>
      ) : (
        <>
          {label}
          {field.kind === "select" ? (
            <select {...shared} defaultValue={value}>
              <option value="">{t("forms.public.chooseOption")}</option>
              {(field.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : field.kind === "address" ? (
            <textarea
              {...shared}
              rows={3}
              defaultValue={value}
              autoComplete="street-address"
            />
          ) : field.kind === "file" ? (
            <input
              {...shared}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              style={{ ...inputStyle(appearance), padding: ".4rem" }}
            />
          ) : (
            <input
              {...shared}
              type={inputTypeFor(field)}
              defaultValue={value}
              placeholder={field.placeholder ?? undefined}
              autoComplete={autoCompleteFor(field)}
              {...(field.kind === "years_in_business" ? { min: 0, step: 1 } : {})}
            />
          )}
          {field.kind === "file" ? (
            <p style={{ fontSize: ".85em", opacity: 0.75, margin: ".2rem 0" }}>
              {t("forms.public.fileHelp", { megabytes: uploadLimitMegabytes })}
            </p>
          ) : null}
          {help}
          {error}
        </>
      )}
    </div>
  );
}

function inputTypeFor(field: FormField): string {
  switch (field.kind) {
    case "email":
      return "email";
    case "phone":
      return "tel";
    case "years_in_business":
      return "number";
    default:
      return "text";
  }
}

function autoCompleteFor(field: FormField): string | undefined {
  switch (field.kind) {
    case "email":
      return "email";
    case "phone":
      return "tel";
    case "company":
      return "organization";
    default:
      return undefined;
  }
}

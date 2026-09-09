/**
 * What a registration form is, and what makes a submission valid.
 *
 * Pure and dependency-free, in the same spirit as the pricing engine. Three
 * places need this answer — the builder's preview, the standalone page, and the
 * app-proxy endpoint the theme block posts to — and a form that validates one
 * way in the admin and another way for a buyer produces applications that
 * silently never arrive.
 */

export const FIELD_KINDS = [
  "text",
  "email",
  "phone",
  "company",
  "address",
  "vat",
  "file",
  "select",
  "checkbox",
  "years_in_business",
  "privacy",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Bounds every free-text answer, so a form post cannot be a payload. */
export const MAX_TEXT_LENGTH = 2000;
export const MAX_FIELDS = 40;
/** The checklist's file rules: pdf/jpg/png, 5MB. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ALLOWED_UPLOAD_TYPES = ["application/pdf", "image/jpeg", "image/png"];

export const FORM_FORMAT_VERSION = 1;

export interface FieldCondition {
  /** Key of the field this one depends on. */
  field: string;
  /** Shown when that field's answer equals this, compared case-insensitively. */
  equals: string;
}

export interface FormField {
  /** Stable key. This is the answer key, and what conditions point at. */
  key: string;
  kind: FieldKind;
  label: string;
  help?: string | null;
  placeholder?: string | null;
  required: boolean;
  /** Options for a select. */
  options?: string[];
  /** Show this field only when the condition holds. */
  showWhen?: FieldCondition | null;
}

export interface FormDefinition {
  v: number;
  fields: FormField[];
}

/** Keys the submission pipeline uses for itself. */
export const RESERVED_KEYS = new Set([
  "id",
  "shop",
  "form",
  "status",
  "_t",
  "website",
  "intent",
]);

export type DefinitionIssueCode =
  | "no_fields"
  | "too_many_fields"
  | "no_email_field"
  | "duplicate_key"
  | "reserved_key"
  | "invalid_key"
  | "no_label"
  | "select_without_options"
  | "condition_unknown_field"
  | "condition_self"
  | "condition_cycle"
  | "condition_on_hidden_option";

export interface DefinitionIssue {
  code: DefinitionIssueCode;
  /** The field the issue is about, when it is about one. */
  key?: string;
  detail?: string;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Check a form before it can go live.
 *
 * A form is the front door of a wholesale business; a broken one loses
 * applications quietly, so these are refused at save time rather than
 * discovered from a buyer's complaint.
 */
export function validateDefinition(definition: FormDefinition): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const fields = definition.fields ?? [];

  if (fields.length === 0) issues.push({ code: "no_fields" });
  if (fields.length > MAX_FIELDS) {
    issues.push({ code: "too_many_fields", detail: String(fields.length) });
  }

  const seen = new Set<string>();
  const byKey = new Map<string, FormField>();

  for (const field of fields) {
    if (!KEY_PATTERN.test(field.key)) {
      issues.push({ code: "invalid_key", key: field.key });
      continue;
    }
    if (RESERVED_KEYS.has(field.key)) {
      issues.push({ code: "reserved_key", key: field.key });
      continue;
    }
    if (seen.has(field.key)) {
      issues.push({ code: "duplicate_key", key: field.key });
      continue;
    }
    seen.add(field.key);
    byKey.set(field.key, field);

    if (!field.label?.trim()) issues.push({ code: "no_label", key: field.key });
    if (field.kind === "select" && (field.options ?? []).length === 0) {
      issues.push({ code: "select_without_options", key: field.key });
    }
  }

  // An application with no email address cannot be answered, cannot be
  // de-duplicated, and cannot become a customer.
  if (!fields.some((field) => field.kind === "email")) {
    issues.push({ code: "no_email_field" });
  }

  issues.push(...conditionIssues(fields, byKey));

  return issues;
}

function conditionIssues(
  fields: FormField[],
  byKey: Map<string, FormField>,
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];

  for (const field of fields) {
    const condition = field.showWhen;
    if (!condition) continue;

    if (condition.field === field.key) {
      issues.push({ code: "condition_self", key: field.key });
      continue;
    }
    if (!byKey.has(condition.field)) {
      issues.push({
        code: "condition_unknown_field",
        key: field.key,
        detail: condition.field,
      });
      continue;
    }

    // "Show the licence upload when Country = KSA" is useful. "Show A when B,
    // show B when A" is a form where neither field can ever appear, and it is
    // very easy to build one field at a time without noticing.
    const cycle = findCycle(field.key, byKey);
    if (cycle) issues.push({ code: "condition_cycle", key: field.key, detail: cycle });
  }

  return issues;
}

/** Walk the showWhen chain from a field; returns the cycle path if it loops. */
function findCycle(start: string, byKey: Map<string, FormField>): string | null {
  const path: string[] = [start];
  const seen = new Set<string>([start]);
  let current = byKey.get(start)?.showWhen?.field;

  while (current) {
    path.push(current);
    if (seen.has(current)) return path.join(" → ");
    seen.add(current);
    current = byKey.get(current)?.showWhen?.field;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Which fields a buyer can actually see                                       */
/* -------------------------------------------------------------------------- */

export type Answers = Record<string, string>;

const sameAnswer = (a: string | undefined, b: string) =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The fields visible for a given set of answers.
 *
 * The server resolves this from the answers rather than trusting the form to
 * have hidden anything: without JavaScript every field is rendered, so a field
 * that a condition hides must not be *required* on the server either. That is
 * what makes the no-JS path work rather than merely render.
 */
export function visibleFields(definition: FormDefinition, answers: Answers): FormField[] {
  const byKey = new Map((definition.fields ?? []).map((field) => [field.key, field]));
  const cache = new Map<string, boolean>();

  const isVisible = (field: FormField, guard: Set<string>): boolean => {
    const cached = cache.get(field.key);
    if (cached !== undefined) return cached;
    // A cycle would be refused at save time; if one is somehow stored, treat
    // the field as hidden rather than looping.
    if (guard.has(field.key)) return false;

    const condition = field.showWhen;
    let visible = true;

    if (condition) {
      const parent = byKey.get(condition.field);
      visible = parent
        ? isVisible(parent, new Set([...guard, field.key])) &&
          sameAnswer(answers[condition.field], condition.equals)
        : false;
    }

    cache.set(field.key, visible);
    return visible;
  };

  return (definition.fields ?? []).filter((field) => isVisible(field, new Set()));
}

/* -------------------------------------------------------------------------- */
/* Validating one submission                                                   */
/* -------------------------------------------------------------------------- */

export type SubmissionIssueCode =
  | "required"
  | "email_format"
  | "phone_format"
  | "number_format"
  | "not_an_option"
  | "too_long"
  | "vat_format"
  | "privacy_required";

export interface SubmissionIssue {
  key: string;
  code: SubmissionIssueCode;
  detail?: string;
}

// Deliberately permissive. A regex strict enough to reject every invalid
// address also rejects real ones, and turning away a real buyer costs more
// than accepting a typo that bounces.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
// A bracketed area code — "(020) 7946-0958" — is how a large part of the
// world writes a phone number, so the first character after an optional "+"
// may be a bracket. The digit count is checked separately: a string of
// brackets matches the shape but is not a phone number.
const PHONE_PATTERN = /^\+?[\d(][\d\s()./-]{5,24}$/;
const MIN_PHONE_DIGITS = 6;

function looksLikePhone(value: string): boolean {
  if (!PHONE_PATTERN.test(value)) return false;
  return (value.match(/\d/g) ?? []).length >= MIN_PHONE_DIGITS;
}

export const CHECKED_VALUES = new Set(["on", "yes", "true", "1"]);
export const isChecked = (value: string | undefined) =>
  CHECKED_VALUES.has((value ?? "").trim().toLowerCase());

export interface ValidateOptions {
  /** Syntactic VAT check, injected so the country table stays out of here. */
  checkVatFormat?: (value: string) => boolean;
}

export function validateSubmission(
  definition: FormDefinition,
  answers: Answers,
  options: ValidateOptions = {},
): SubmissionIssue[] {
  const issues: SubmissionIssue[] = [];

  for (const field of visibleFields(definition, answers)) {
    const raw = answers[field.key];
    const value = (raw ?? "").trim();

    if (field.kind === "checkbox" || field.kind === "privacy") {
      if (field.required && !isChecked(raw)) {
        issues.push({
          key: field.key,
          code: field.kind === "privacy" ? "privacy_required" : "required",
        });
      }
      continue;
    }

    if (!value) {
      // A file field's presence is checked by the caller: the bytes do not
      // travel in `answers`.
      if (field.required && field.kind !== "file") {
        issues.push({ key: field.key, code: "required" });
      }
      continue;
    }

    if (value.length > MAX_TEXT_LENGTH) {
      issues.push({ key: field.key, code: "too_long" });
      continue;
    }

    switch (field.kind) {
      case "email":
        if (!EMAIL_PATTERN.test(value)) {
          issues.push({ key: field.key, code: "email_format" });
        }
        break;
      case "phone":
        if (!looksLikePhone(value)) {
          issues.push({ key: field.key, code: "phone_format" });
        }
        break;
      case "years_in_business": {
        const years = Number(value);
        if (!Number.isInteger(years) || years < 0 || years > 500) {
          issues.push({ key: field.key, code: "number_format" });
        }
        break;
      }
      case "select":
        if (!(field.options ?? []).some((option) => sameAnswer(value, option))) {
          issues.push({ key: field.key, code: "not_an_option" });
        }
        break;
      case "vat":
        if (options.checkVatFormat && !options.checkVatFormat(value)) {
          // A format we do not recognise is a warning on the reviewer's desk,
          // not a closed door: our country table is not the whole world.
          issues.push({ key: field.key, code: "vat_format" });
        }
        break;
      default:
        break;
    }
  }

  return issues;
}

/** The email address an application is keyed on. */
export function emailFrom(definition: FormDefinition, answers: Answers): string | null {
  const field = (definition.fields ?? []).find((entry) => entry.kind === "email");
  const value = field ? (answers[field.key] ?? "").trim().toLowerCase() : "";
  return value || null;
}

export function firstOfKind(
  definition: FormDefinition,
  kind: FieldKind,
  answers: Answers,
): string | null {
  const field = (definition.fields ?? []).find((entry) => entry.kind === kind);
  const value = field ? (answers[field.key] ?? "").trim() : "";
  return value || null;
}

/* -------------------------------------------------------------------------- */
/* Reading a stored definition                                                 */
/* -------------------------------------------------------------------------- */

/** Never throws: a form that will not parse must not take the page down. */
export function readDefinition(value: unknown): FormDefinition {
  if (typeof value !== "object" || value === null)
    return { v: FORM_FORMAT_VERSION, fields: [] };

  const node = value as Partial<FormDefinition>;
  if (!Array.isArray(node.fields)) return { v: FORM_FORMAT_VERSION, fields: [] };

  const fields: FormField[] = [];

  for (const raw of node.fields) {
    const field = raw as Partial<FormField>;
    if (
      typeof field?.key !== "string" ||
      !FIELD_KINDS.includes(field.kind as FieldKind)
    ) {
      continue;
    }

    fields.push({
      key: field.key,
      kind: field.kind as FieldKind,
      label: typeof field.label === "string" ? field.label : field.key,
      help: typeof field.help === "string" ? field.help : null,
      placeholder: typeof field.placeholder === "string" ? field.placeholder : null,
      required: field.required === true,
      options: Array.isArray(field.options)
        ? field.options.filter((option): option is string => typeof option === "string")
        : undefined,
      showWhen:
        field.showWhen &&
        typeof field.showWhen.field === "string" &&
        typeof field.showWhen.equals === "string"
          ? { field: field.showWhen.field, equals: field.showWhen.equals }
          : null,
    });
  }

  return { v: FORM_FORMAT_VERSION, fields };
}

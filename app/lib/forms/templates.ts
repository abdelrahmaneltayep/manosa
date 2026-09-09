import {
  DEFAULT_APPEARANCE,
  DEFAULT_PUBLISH,
  type Appearance,
  type PublishSettings,
} from "~/lib/forms/appearance";
import type { EmailTemplates } from "~/lib/forms/merge-tags";
import {
  FORM_FORMAT_VERSION,
  type FormDefinition,
  type FormField,
} from "~/lib/forms/schema";

/**
 * The three starter forms the empty state offers.
 *
 * They differ in how much they ask for, because that is the real decision a
 * merchant is making: every extra field costs applications, and a strict form
 * is only worth it when the wrong buyer costs more than the lost ones.
 *
 * Labels and email copy are catalog keys, not strings — a merchant on the
 * Arabic admin should get an Arabic form, not an English one to translate.
 */

export const TEMPLATE_KEYS = ["minimal", "standard", "strict"] as const;
export type FormTemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface FormTemplate {
  key: FormTemplateKey;
  i18nKey: string;
  /** One line on the trade-off, shown next to the choice. */
  descriptionKey: string;
  slug: string;
  fields: (FormField & { labelKey: string; helpKey?: string })[];
}

const field = (
  key: string,
  kind: FormField["kind"],
  labelKey: string,
  required: boolean,
  extra: Partial<FormField> & { helpKey?: string } = {},
) => ({ key, kind, label: labelKey, labelKey, required, ...extra });

export const FORM_TEMPLATES: Record<FormTemplateKey, FormTemplate> = {
  minimal: {
    key: "minimal",
    i18nKey: "forms.template.minimal",
    descriptionKey: "forms.template.minimalHelp",
    slug: "wholesale",
    fields: [
      field("first_name", "text", "forms.field.firstName", true),
      field("last_name", "text", "forms.field.lastName", true),
      field("email", "email", "forms.field.email", true),
      field("company", "company", "forms.field.company", true),
      field("privacy", "privacy", "forms.field.privacy", true),
    ],
  },

  standard: {
    key: "standard",
    i18nKey: "forms.template.standard",
    descriptionKey: "forms.template.standardHelp",
    slug: "wholesale-application",
    fields: [
      field("first_name", "text", "forms.field.firstName", true),
      field("last_name", "text", "forms.field.lastName", true),
      field("email", "email", "forms.field.email", true),
      field("phone", "phone", "forms.field.phone", true),
      field("company", "company", "forms.field.company", true),
      field("address", "address", "forms.field.address", false),
      field("vat", "vat", "forms.field.vat", false, {
        helpKey: "forms.field.vatHelp",
      }),
      field("years", "years_in_business", "forms.field.years", false),
      field("privacy", "privacy", "forms.field.privacy", true),
    ],
  },

  strict: {
    key: "strict",
    i18nKey: "forms.template.strict",
    descriptionKey: "forms.template.strictHelp",
    slug: "wholesale-verification",
    fields: [
      field("first_name", "text", "forms.field.firstName", true),
      field("last_name", "text", "forms.field.lastName", true),
      field("email", "email", "forms.field.email", true),
      field("phone", "phone", "forms.field.phone", true),
      field("company", "company", "forms.field.company", true),
      field("address", "address", "forms.field.address", true),
      field("business_type", "select", "forms.field.businessType", true, {
        options: ["Retailer", "Distributor", "Restaurant / café", "Other"],
      }),
      field("vat", "vat", "forms.field.vat", true, { helpKey: "forms.field.vatHelp" }),
      field("years", "years_in_business", "forms.field.years", true),
      // The licence is only asked for when it is actually required, which is
      // the point of conditional logic: a distributor uploading nothing
      // because the field never applied to them is not an incomplete
      // application.
      field("licence", "file", "forms.field.licence", true, {
        showWhen: { field: "business_type", equals: "Distributor" },
        helpKey: "forms.field.licenceHelp",
      }),
      field("privacy", "privacy", "forms.field.privacy", true),
    ],
  },
};

export function isFormTemplateKey(value: unknown): value is FormTemplateKey {
  return (
    typeof value === "string" && (TEMPLATE_KEYS as readonly string[]).includes(value)
  );
}

/** Build a form definition from a template, with labels translated. */
export function definitionFromTemplate(
  template: FormTemplate,
  t: (key: string) => string,
): FormDefinition {
  return {
    v: FORM_FORMAT_VERSION,
    fields: template.fields.map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      label: t(entry.labelKey),
      help: entry.helpKey ? t(entry.helpKey) : null,
      placeholder: null,
      required: entry.required,
      options: entry.options,
      showWhen: entry.showWhen ?? null,
    })),
  };
}

/**
 * The starting email templates.
 *
 * Written out rather than left blank: a merchant who publishes a form with an
 * empty confirmation email has a buyer who applies and hears nothing, and the
 * empty field gives no clue that is what will happen.
 */
export function emailsFromTemplate(t: (key: string) => string): EmailTemplates {
  return {
    confirmation: {
      subject: t("forms.emails.confirmationSubject"),
      body: t("forms.emails.confirmationBody"),
    },
    approved: {
      subject: t("forms.emails.approvedSubject"),
      body: t("forms.emails.approvedBody"),
    },
    rejected: {
      subject: t("forms.emails.rejectedSubject"),
      body: t("forms.emails.rejectedBody"),
    },
    needs_info: {
      subject: t("forms.emails.needsInfoSubject"),
      body: t("forms.emails.needsInfoBody"),
    },
  };
}

export function appearanceFromTemplate(): Appearance {
  return { ...DEFAULT_APPEARANCE };
}

export function publishFromTemplate(): PublishSettings {
  return { ...DEFAULT_PUBLISH };
}

import { parseMoney, type PricingRule, type VolumeTier } from "@mannon/pricing-engine";

import { db } from "~/db.server";
import type { Translate } from "~/i18n/translate";
import type {
  SetupGrounding,
  SetupPlan,
  WizardFieldKey,
} from "~/lib/ai/prompts/setup-plan.server";
import { recordAudit } from "~/lib/audit/record.server";
import { createGroup } from "~/lib/customers/groups.server";
import {
  appearanceFromTemplate,
  emailsFromTemplate,
  publishFromTemplate,
} from "~/lib/forms/templates";
import { createForm } from "~/lib/forms/forms.server";
import { FORM_FORMAT_VERSION, type FormField } from "~/lib/forms/schema";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { createRule } from "~/lib/pricing/rules.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Turning a plan into a shop.
 *
 * The plan came from Claude; everything here is ours. Each piece is created
 * through the same function the manual path uses — `createGroup`, `createRule`,
 * `createForm` — so a wizard-built rule is validated, limit-checked, published
 * to the Function and audited exactly like one built by hand. There is no
 * second, looser way in.
 *
 * The whole thing is one approval: the merchant read the preview and pressed
 * the button, and that click is what `recordAudit` requires before anything
 * `aiAssisted` may touch live pricing.
 */

/** Each wizard field key, as a real field on a real form. */
const FIELD_SPECS: Record<
  WizardFieldKey,
  { kind: FormField["kind"]; labelKey: string; helpKey?: string; required: boolean }
> = {
  company: { kind: "company", labelKey: "forms.field.company", required: true },
  email: { kind: "email", labelKey: "forms.field.email", required: true },
  phone: { kind: "phone", labelKey: "forms.field.phone", required: false },
  vat_number: {
    kind: "vat",
    labelKey: "forms.field.vat",
    helpKey: "forms.field.vatHelp",
    required: false,
  },
  website: { kind: "text", labelKey: "forms.field.website", required: false },
  business_type: { kind: "text", labelKey: "forms.field.businessType", required: false },
  years_trading: {
    kind: "years_in_business",
    labelKey: "forms.field.years",
    required: false,
  },
  resale_certificate: {
    kind: "file",
    labelKey: "forms.field.resaleCertificate",
    helpKey: "forms.field.licenceHelp",
    required: false,
  },
  estimated_volume: {
    kind: "text",
    labelKey: "forms.field.estimatedVolume",
    required: false,
  },
  how_did_you_hear: {
    kind: "text",
    labelKey: "forms.field.howDidYouHear",
    required: false,
  },
};

export async function setupGrounding(): Promise<SetupGrounding> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("setup wizard") },
  });

  const [groups, forms, rules] = await Promise.all([
    db.customerGroup.findMany({
      select: { name: true, tag: true },
      orderBy: { sortOrder: "asc" },
    }),
    db.registrationForm.count({ where: { archivedAt: null } }),
    db.pricingRule.count({ where: { archivedAt: null } }),
  ]);

  return {
    currencyCode: shop?.currencyCode ?? "USD",
    groups: groups.map((group) => ({ name: group.name, tag: group.tag })),
    hasForm: forms > 0,
    hasRule: rules > 0,
  };
}

/** The plan as a pricing rule the engine will accept. */
export function ruleFromPlan(
  plan: SetupPlan,
  now: Date,
  currencyCode: string,
): PricingRule | null {
  if (!plan.rule) return null;
  const planned = plan.rule;

  const base = {
    id: "new",
    name: planned.name,
    status: "active" as const,
    priority: 100,
    combinable: false,
    targets: { mode: "all" as const },
    audience: { mode: "tags" as const, tags: [planned.audienceTag] },
    markets: { mode: "all" as const, marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: now,
  };

  if (planned.kind === "percentage") {
    return {
      ...base,
      kind: "percentage",
      value: { percentage: planned.percentage ?? 0 },
    };
  }

  if (planned.kind === "amount_off") {
    // No per-currency overrides: the wizard priced in the shop's own currency,
    // and the engine skips the rule elsewhere rather than converting.
    if (!planned.amount) return null;
    return {
      ...base,
      kind: "amount_off",
      value: { base: parseMoney(planned.amount, currencyCode), overrides: {} },
    };
  }

  const tiers: VolumeTier[] = planned.tiers.map((tier) => ({
    minQuantity: tier.minQuantity,
    maxQuantity: tier.maxQuantity,
    kind: "percentage",
    percentage: tier.percentage,
  }));

  return { ...base, kind: "volume_tier", value: { tiers } };
}

export interface AppliedSetup {
  groups: string[];
  ruleId: string | null;
  formId: string | null;
}

/**
 * Something was created, and then something else failed.
 *
 * Applying is not one transaction — a rule has to be published to Shopify's
 * Function, which is not a thing a database transaction can roll back — so a
 * run can stop half way. When it does, the merchant has to be told what
 * exists, or they are looking at a shop that changed under them while the
 * screen said "nothing was created".
 */
export class PartialSetupError extends Error {
  constructor(
    readonly applied: AppliedSetup,
    readonly reason: unknown,
  ) {
    super("The setup was applied in part.");
    this.name = "PartialSetupError";
  }
}

export interface ApplyOptions {
  admin: AdminGraphql;
  /** The shop's currency. The plan's amounts are decimals in it. */
  currencyCode: string;
  /** The merchant who pressed the button. Nothing applies without one. */
  approvedById: string;
  t: Translate;
  ai: { model: string; promptVersion: string; requestId: string | null };
  now?: Date;
}

/**
 * Apply a plan the merchant has read.
 *
 * Ordered so that a failure leaves the shop in a state the merchant can
 * understand: groups first (a group with no rule is harmless), then the rule,
 * then the form, which is the only piece a buyer can see. Each step is
 * separately audited by the function that does it; the entry written here is
 * the one that says a person approved the lot.
 */
export async function applySetupPlan(
  plan: SetupPlan,
  options: ApplyOptions,
): Promise<AppliedSetup> {
  const now = options.now ?? new Date();
  const actor = { type: "STAFF" as const, id: options.approvedById };

  const applied: AppliedSetup = { groups: [], ruleId: null, formId: null };

  try {
    return await applyEach(plan, options, actor, now, applied);
  } catch (error) {
    // Anything already created stays created; the caller is handed the list so
    // the screen can say so and the merchant can pick up where it stopped.
    if (applied.groups.length > 0 || applied.ruleId || applied.formId) {
      throw new PartialSetupError(applied, error);
    }
    throw error;
  }
}

async function applyEach(
  plan: SetupPlan,
  options: ApplyOptions,
  actor: { type: "STAFF"; id: string },
  now: Date,
  applied: AppliedSetup,
): Promise<AppliedSetup> {
  const groups: string[] = applied.groups;
  for (const planned of plan.groups) {
    const created = await createGroup(
      {
        name: planned.name,
        tag: planned.tag,
        description: planned.description,
      },
      actor,
    );
    groups.push(created.id);
  }

  const rule = ruleFromPlan(plan, now, options.currencyCode);
  const ruleRow = rule
    ? await createRule(rule, {
        admin: options.admin,
        actor,
        // The invariant, in one object: which model, which prompt, and the
        // merchant who approved it. `recordAudit` refuses the entry without it.
        provenance: {
          ai: options.ai,
          approvedById: options.approvedById,
          metadata: { source: "setup_wizard" },
        },
      })
    : null;
  applied.ruleId = ruleRow?.id ?? null;

  const formRow = plan.form
    ? await createForm(
        {
          name: plan.form.name,
          definition: {
            v: FORM_FORMAT_VERSION,
            fields: [
              ...plan.form.fields.map((key) => fieldFor(key, options.t)),
              {
                key: "privacy",
                kind: "privacy" as const,
                label: options.t("forms.field.privacy"),
                help: null,
                placeholder: null,
                required: true,
                showWhen: null,
              },
            ],
          },
          appearance: appearanceFromTemplate(),
          emails: emailsFromTemplate(options.t),
          publish: { ...publishFromTemplate(), autoTags: [plan.form.autoTag] },
          // Draft, not live. Publishing a form is a decision about what buyers
          // see, and the wizard has not shown the merchant the buyer's view.
          status: "DRAFT",
        },
        actor,
      )
    : null;
  applied.formId = formRow?.id ?? null;

  await recordAudit({
    actor,
    action: "setup.wizard_applied",
    summary: `Approved Claude's setup: ${plan.groups.length} customer group(s)${
      ruleRow ? ", a starter pricing rule" : ""
    }${formRow ? ", a registration form" : ""}.`,
    metadata: {
      groups: plan.groups.map((group) => group.name),
      rule: ruleRow?.id ?? null,
      form: formRow?.id ?? null,
    },
    ai: options.ai,
    aiAssisted: true,
    approval: { byId: options.approvedById },
  });

  return {
    groups,
    ruleId: ruleRow?.id ?? null,
    formId: formRow?.id ?? null,
  };
}

function fieldFor(key: WizardFieldKey, t: Translate): FormField {
  const spec = FIELD_SPECS[key];
  return {
    key,
    kind: spec.kind,
    label: t(spec.labelKey),
    help: spec.helpKey ? t(spec.helpKey) : null,
    placeholder: null,
    required: spec.required,
    showWhen: null,
  };
}

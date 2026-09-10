/**
 * The setup wizard, as plain serialisable data.
 *
 * The plan on this view is already formatted for reading: the rule's summary
 * is a sentence, not a `PricingRule`, because the page must not be the thing
 * that decides how a rule reads. What gets applied is the payload, re-read and
 * re-validated on the server.
 */

export interface WizardGroupView {
  name: string;
  tag: string;
  description: string;
}

export interface WizardPlanView {
  summary: string;
  groups: WizardGroupView[];
  /** Null when this shop already has pricing rules. */
  rule: {
    name: string;
    summary: string;
    /** The tag it prices for, named so the merchant can check it. */
    audienceTag: string;
    /** How many of their customers already carry that tag. */
    reaches: number;
  } | null;
  /** Null when this shop already has a registration form. */
  form: { name: string; fields: string[] } | null;
  notes: string | null;
}

export interface WizardView {
  /** False with no key, or on a plan without the Merchant Agent. */
  available: boolean;
  locked: "no_key" | "plan" | null;
  /** What the merchant typed, echoed back. */
  description: string;
  plan: WizardPlanView | null;
  /** The plan itself, carried between requests and re-validated on apply. */
  payload: string;
  failure:
    | "no_key"
    | "timeout"
    | "rate_limited"
    | "refused"
    | "invalid_output"
    | "error"
    | "empty"
    | "limit"
    | "duplicate"
    | "invalid_rule"
    | null;
  /**
   * What a failed run managed to create before it stopped.
   *
   * Null when nothing was created. Applying is not one transaction — a rule is
   * published to Shopify's Function, which no database transaction can roll
   * back — so this is how the screen avoids saying "nothing happened" to a
   * merchant whose shop just changed.
   */
  partial: { groups: number; rule: boolean; form: boolean } | null;

  /** Set once the merchant has applied it. */
  applied: {
    links: { label: string; href: string }[];
    /** The form was created as a draft, so the page says so. */
    formDraft: boolean;
  } | null;
}

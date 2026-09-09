import type { Appearance, PublishSettings } from "~/lib/forms/appearance";
import type { ApprovalCriteria, ApprovalIssue } from "~/lib/forms/approval";
import type { ContrastVerdict } from "~/lib/forms/contrast";
import type { EmailIssue, EmailTemplates } from "~/lib/forms/merge-tags";
import type { DefinitionIssue, FormField } from "~/lib/forms/schema";

/**
 * Everything the form screens render, as plain serialisable data.
 *
 * The pages are pure functions of these, so every state in checklist §4 —
 * empty, over quota, a form that cannot go live, a colour that fails contrast,
 * an email with a tag that will never fill in — renders in a test.
 */

export interface FormCardView {
  id: string;
  name: string;
  slug: string;
  status: "DRAFT" | "LIVE";
  /** Applications in the last 30 days. */
  submissions30d: number;
  /** Views in the last 30 days. Zero means the rate cannot be computed. */
  views30d: number;
  /** Whole-percent conversion, or null when nobody has looked at it yet. */
  conversion: number | null;
  lastEditedAt: string;
  /** The public link, for copying. */
  publicUrl: string;
  /** Set when the form has problems that stop it going live. */
  blockingIssues: number;
}

export interface FormListView {
  rows: FormCardView[];
  templates: { key: string; name: string; description: string }[];
  /** Plan quota reached — the Free plan allows one form. */
  atFormLimit: boolean;
  /** The plan that lifts the quota. */
  requiredPlan: string | null;
  /** ✦ Generate a form needs the AI layer (phase 4.3). */
  aiAvailable: boolean;
}

export type BuilderTab = "configuration" | "appearance" | "emails" | "publish";

export interface FieldRowView extends FormField {
  /** Position, for the reorder controls. */
  index: number;
  /** True when nothing can depend on this field. */
  canBeCondition: boolean;
}

export interface RecentApplicationView {
  id: string;
  who: string;
  at: string;
  status: string;
  vatStatus: string;
  uploads: { id: string; fileName: string; scanned: boolean }[];
}

export interface FormBuilderView {
  id: string;
  name: string;
  slug: string;
  status: "DRAFT" | "LIVE";
  tab: BuilderTab;
  fields: FieldRowView[];
  appearance: Appearance;
  emails: EmailTemplates;
  publish: PublishSettings;
  approval: ApprovalCriteria;
  approvalIssues: ApprovalIssue[];
  /** Groups an approved applicant can be put into. */
  groups: { id: string; name: string }[];
  definitionIssues: DefinitionIssue[];
  emailIssues: EmailIssue[];
  /** Text on background, and accent text on accent. */
  contrast: { text: ContrastVerdict; accent: ContrastVerdict };
  publicUrl: string;
  /** The last few applications, so the pipeline is visible before 2.3. */
  recent: RecentApplicationView[];
  recentTotal: number;
  /** Set when a test send was attempted and no sender is configured. */
  testSend: "no_sender" | "sent" | null;
  /** The store's country, for the VAT field's example. */
  vatExample: string | null;
  saving: boolean;
}

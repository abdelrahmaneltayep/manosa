/**
 * Merge tags in the notification emails.
 *
 * A tag that is not filled in is worse than no tag: "Hi {{first_name}}" goes
 * out to a real buyer. So unknown tags are refused at save time, and rendering
 * a known tag with no value substitutes nothing rather than leaving the braces
 * on the page.
 */

export const MERGE_TAGS = [
  "first_name",
  "last_name",
  "company",
  "email",
  "shop_name",
  "form_name",
  "group_name",
  "reason",
] as const;
export type MergeTag = (typeof MERGE_TAGS)[number];

const TAG_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Tags used in a template, in the order they appear, de-duplicated. */
export function tagsIn(template: string): string[] {
  return [...new Set([...template.matchAll(TAG_PATTERN)].map((match) => match[1]!))];
}

/** Tags a template uses that are not merge tags at all. */
export function unknownTags(template: string): string[] {
  const known = new Set<string>(MERGE_TAGS);
  return tagsIn(template).filter((tag) => !known.has(tag));
}

/**
 * Fill in a template.
 *
 * A tag with no value becomes an empty string, not the literal braces: the
 * merchant wrote "Hi {{first_name}}," and a buyer with no first name should
 * read "Hi," rather than "Hi {{first_name}},".
 */
export function renderTemplate(
  template: string,
  values: Partial<Record<MergeTag, string | null | undefined>>,
): string {
  return template.replace(TAG_PATTERN, (_match, tag: string) => {
    const value = values[tag as MergeTag];
    return value == null ? "" : String(value);
  });
}

export type EmailKey = "confirmation" | "approved" | "rejected" | "needs_info";
export const EMAIL_KEYS: EmailKey[] = [
  "confirmation",
  "approved",
  "rejected",
  "needs_info",
];

export interface EmailTemplate {
  subject: string;
  body: string;
}

export type EmailTemplates = Record<EmailKey, EmailTemplate>;

export interface EmailIssue {
  email: EmailKey;
  code: "no_subject" | "no_body" | "unknown_tag";
  detail?: string;
}

export function validateEmails(templates: EmailTemplates): EmailIssue[] {
  const issues: EmailIssue[] = [];

  for (const key of EMAIL_KEYS) {
    const template = templates[key];
    if (!template?.subject?.trim()) issues.push({ email: key, code: "no_subject" });
    if (!template?.body?.trim()) issues.push({ email: key, code: "no_body" });
    if (!template) continue;

    for (const tag of [
      ...unknownTags(template.subject ?? ""),
      ...unknownTags(template.body ?? ""),
    ]) {
      issues.push({ email: key, code: "unknown_tag", detail: tag });
    }
  }

  return issues;
}

/** Never throws; a malformed stored value falls back to empty templates. */
export function readEmails(value: unknown): EmailTemplates {
  const node = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const out = {} as EmailTemplates;

  for (const key of EMAIL_KEYS) {
    const template = node[key] as Partial<EmailTemplate> | undefined;
    out[key] = {
      subject: typeof template?.subject === "string" ? template.subject : "",
      body: typeof template?.body === "string" ? template.body : "",
    };
  }

  return out;
}

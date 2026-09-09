import {
  MAX_UPLOAD_BYTES,
  type FormField,
  type SubmissionIssue,
} from "~/lib/forms/schema";

/**
 * Turning a validation issue into a sentence a buyer can act on.
 *
 * Kept out of the component so the same wording is used everywhere, and so an
 * error can name the field the buyer is looking at rather than saying "this
 * field". It takes `t` rather than holding strings: the buyer's language is
 * the storefront visitor's, not the merchant's.
 */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const uploadLimitMegabytes = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

export function issueMessage(
  issue: SubmissionIssue,
  field: FormField | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const label = field?.label ?? issue.key;

  if (issue.code === "too_long" && issue.detail) {
    const size = Number(issue.detail);
    // The applicant needs to know by how much, not that it is "too large".
    if (Number.isFinite(size)) {
      return t("forms.public.issue.fileTooLarge", {
        label,
        size: formatBytes(size),
        limit: `${uploadLimitMegabytes} MB`,
      });
    }
  }

  if (issue.code === "not_an_option" && issue.detail?.includes("/")) {
    return t("forms.public.issue.fileType", { label, type: issue.detail });
  }

  return t(`forms.public.issue.${issue.code}`, { label });
}

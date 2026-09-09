import type { Prisma } from "@prisma/client";

import { db } from "~/db.server";
import { readApproval, type ApprovalVerdict } from "~/lib/forms/approval";
import { domainOf } from "~/lib/forms/approval";
import { evaluateApproval } from "~/lib/forms/approval";
import { factsFor } from "~/lib/forms/decisions.server";
import { readDefinition, type Answers } from "~/lib/forms/schema";

/**
 * The applications queue.
 *
 * Every row carries the evaluator's working, not just its verdict: a merchant
 * handed "meets your criteria" with nothing behind it cannot tell a good rule
 * from one that is letting everybody through, and letting the wrong buyer
 * through means selling at wholesale to somebody who resells against you.
 */

export const APPLICATIONS_PAGE_SIZE = 25;

export interface ApplicationRow {
  id: string;
  formId: string;
  formName: string;
  company: string | null;
  contact: string;
  email: string;
  submittedAt: Date;
  vatStatus: string;
  vatNote: string | null;
  uploads: { id: string; fileName: string; scanned: boolean }[];
  /** The evaluator's verdict, recomputed for display. */
  verdict: ApprovalVerdict;
  /** Other pending applications from the same email domain. */
  sameDomainCount: number;
  /** Shopify already has a customer with this email. */
  existingCustomer: boolean;
  answers: Answers;
}

export interface ApplicationsFilters {
  formId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface ApplicationsPage {
  rows: ApplicationRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Applications waiting before filters — tells empty from no-results. */
  totalWaiting: number;
}

export async function listApplications(
  filters: ApplicationsFilters = {},
): Promise<ApplicationsPage> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? APPLICATIONS_PAGE_SIZE;

  const where: Prisma.FormSubmissionWhereInput = {
    status: "PENDING",
    ...(filters.formId ? { formId: filters.formId } : {}),
    ...(filters.search
      ? {
          OR: [
            { email: { contains: filters.search, mode: "insensitive" } },
            { company: { contains: filters.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total, totalWaiting] = await Promise.all([
    db.formSubmission.findMany({
      where,
      include: {
        form: true,
        uploads: {
          select: { id: true, fileName: true, scannedAt: true, fieldKey: true },
        },
      },
      // Oldest first: an applications queue is a queue, and the person who has
      // been waiting longest is the one being kept waiting.
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.formSubmission.count({ where }),
    db.formSubmission.count({ where: { status: "PENDING" } }),
  ]);

  // Two lookups for the whole page rather than two per row.
  const emails = rows.map((row) => row.email);
  const mirrored = await db.customer.findMany({
    where: { email: { in: emails } },
    select: { email: true, countryCode: true },
  });
  const byEmail = new Map(
    mirrored.map((customer) => [customer.email?.toLowerCase() ?? "", customer]),
  );

  const domains = [
    ...new Set(emails.map(domainOf).filter((d): d is string => d !== null)),
  ];
  const domainCounts = await countPendingByDomain(domains);

  return {
    rows: rows.map((row) => {
      const definition = readDefinition(row.form.fields);
      const answers = (row.answers ?? {}) as Answers;
      const customer = byEmail.get(row.email.toLowerCase()) ?? null;
      const domain = domainOf(row.email);

      return {
        id: row.id,
        formId: row.formId,
        formName: row.form.name,
        company: row.company,
        contact: contactName(definition, answers) ?? row.email,
        email: row.email,
        submittedAt: row.createdAt,
        vatStatus: row.vatStatus,
        vatNote: row.vatNote,
        uploads: row.uploads.map((upload) => ({
          id: upload.id,
          fileName: upload.fileName,
          scanned: upload.scannedAt !== null,
        })),
        verdict: evaluateApproval(
          readApproval(row.form.approval),
          factsFor({
            submission: row,
            form: row.form,
            uploadedFields: row.uploads.map((upload) => upload.fieldKey),
            existingCustomer: customer !== null,
            countryCode: customer?.countryCode ?? null,
          }),
        ),
        // Minus this one: "3 others from acme.test" means three others.
        sameDomainCount: Math.max(0, (domain ? (domainCounts.get(domain) ?? 0) : 0) - 1),
        existingCustomer: customer !== null,
        answers,
      };
    }),
    total,
    page,
    pageSize,
    totalWaiting,
  };
}

/** Pending applications per email domain, for the duplicate hint. */
async function countPendingByDomain(domains: string[]): Promise<Map<string, number>> {
  if (domains.length === 0) return new Map();

  const rows = await db.formSubmission.findMany({
    where: {
      status: "PENDING",
      OR: domains.map((domain) => ({ email: { endsWith: `@${domain}` } })),
    },
    select: { email: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    const domain = domainOf(row.email);
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
}

/** The person's name, from the first two text answers. */
function contactName(
  definition: ReturnType<typeof readDefinition>,
  answers: Answers,
): string | null {
  const parts = definition.fields
    .filter((field) => field.kind === "text")
    .slice(0, 2)
    .map((field) => (answers[field.key] ?? "").trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : null;
}

/** One application, for the edit-email screen. */
export async function getApplication(id: string) {
  return db.formSubmission.findUnique({
    where: { id },
    include: {
      form: true,
      uploads: {
        select: { id: true, fileName: true, scannedAt: true, fieldKey: true },
      },
    },
  });
}

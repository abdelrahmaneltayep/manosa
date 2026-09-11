import { db } from "~/db.server";
import { aiGate } from "~/lib/ai/permissions.server";
import { domainOf } from "~/lib/forms/approval";
import { screenSubmission } from "~/lib/forms/screening.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * ✦ Screen the applications nobody has looked at yet.
 *
 * A background job rather than part of the submission, for the same reason the
 * evaluator is: a buyer pressing "send" must not wait on a model, and a model
 * that is down must not cost anyone their application.
 *
 * Claims work by `screenedAt`, so a crash mid-batch resumes rather than
 * re-screening what it already paid for. An application is screened once: a
 * verdict that changes on refresh is not a verdict a merchant can act on.
 */

/** How many one run screens. Bounded — each is a model call the shop pays for. */
export const SCREEN_BATCH = 10;

export async function screenApplications() {
  const shop = shopScope.require("screenApplications");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  const waiting = await db.formSubmission.findMany({
    where: { status: "PENDING", screenedAt: null },
    orderBy: { createdAt: "asc" },
    take: SCREEN_BATCH,
    include: { form: true, uploads: { select: { fieldKey: true, scannedAt: true } } },
  });

  if (waiting.length === 0) return { examined: 0, recommended: 0, look: 0, failed: 0 };

  // Three reasons this can be off — the merchant switched screening off, the
  // plan does not include it, or there is no key — and `aiGate` is the only
  // place that knows all three. Marked OFF rather than left WAITING: a queue
  // that says "checking…" forever is a worse lie than "not screened".
  if (!(await aiGate("screen")).allowed) {
    await db.formSubmission.updateMany({
      where: { id: { in: waiting.map((row) => row.id) } },
      data: { screening: "OFF", screenedAt: new Date() },
    });
    return { examined: waiting.length, recommended: 0, look: 0, failed: 0, off: true };
  }

  const emails = waiting.map((row) => row.email);
  const domains = [
    ...new Set(emails.map(domainOf).filter((one): one is string => one !== null)),
  ];
  const [customers, pendingByDomain] = await Promise.all([
    db.customer.findMany({
      where: { email: { in: emails, mode: "insensitive" } },
      select: { email: true, countryCode: true },
    }),
    countPendingByDomain(domains),
  ]);
  const byEmail = new Map(
    customers.map((customer) => [customer.email?.toLowerCase() ?? "", customer]),
  );

  const result = { examined: 0, recommended: 0, look: 0, failed: 0 };

  for (const submission of waiting) {
    const customer = byEmail.get(submission.email.toLowerCase()) ?? null;
    const domain = domainOf(submission.email);

    const verdict = await screenSubmission({
      submission,
      existingCustomer: customer !== null,
      countryCode: customer?.countryCode ?? null,
      // Minus this one, so "2 others waiting" means two others.
      otherPendingFromDomain: Math.max(
        0,
        (domain ? (pendingByDomain.get(domain) ?? 0) : 0) - 1,
      ),
      storeCountry: record.countryCode,
    });

    result.examined += 1;
    if (verdict === "RECOMMEND") result.recommended += 1;
    else if (verdict === "LOOK") result.look += 1;
    else result.failed += 1;
  }

  return result;
}

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

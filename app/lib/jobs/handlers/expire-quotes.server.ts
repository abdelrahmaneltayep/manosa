import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { deliverQuoteEmail } from "~/lib/quotes/email.server";
import {
  DEFAULT_REMINDER_DAYS,
  hasExpired,
  isDueForReminder,
  type QuoteState,
} from "~/lib/quotes/state";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Expire quotes that have run out, and warn about the ones about to.
 *
 * Runs on a schedule rather than on read, so a quote that nobody looks at still
 * expires — a merchant's list must not show something as live because they have
 * not refreshed the page, and the buyer's own link must stop working on time.
 *
 * The buyer's accept page checks the date too, so a race between the job and a
 * buyer at 23:59 cannot let an expired quote through.
 *
 * There is no recurring scheduler in this app, so the job keeps itself alive:
 * it re-queues for tomorrow while any quote is still out with a buyer, and
 * stops when none is. Sending a quote queues one too, so a store with nothing
 * outstanding runs nothing.
 */
export async function expireQuotes({ now = new Date() } = {}) {
  const shop = shopScope.require("expireQuotes");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  const sent = await db.quote.findMany({
    where: { status: "SENT", expiresAt: { not: null } },
    include: { lines: true },
  });

  let expired = 0;
  let reminded = 0;

  for (const quote of sent) {
    const state = quote as unknown as {
      status: QuoteState;
      expiresAt: Date | null;
      remindedAt: Date | null;
    };

    if (hasExpired(state, now)) {
      await db.quote.update({ where: { id: quote.id }, data: { status: "EXPIRED" } });
      expired += 1;
      continue;
    }

    if (
      quote.email &&
      isDueForReminder(state, now, record.quoteReminderDays ?? DEFAULT_REMINDER_DAYS)
    ) {
      // Stamped whatever the provider said. A failed send is recorded in
      // `EmailMessage` with its error; retrying it every hour would not help
      // and would chase the buyer once the provider recovered.
      await deliverQuoteEmail(quote, "quote_expiring", record.name ?? shop);
      await db.quote.update({ where: { id: quote.id }, data: { remindedAt: now } });
      reminded += 1;
    }
  }

  if (expired > 0) {
    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: "quote.expired",
      summary:
        expired === 1
          ? `One quote reached its expiry date and is no longer open to accept.`
          : `${expired} quotes reached their expiry date and are no longer open to accept.`,
      subject: { type: "Shop", id: shop },
      metadata: { expired, reminded },
    });
  }

  // Still work to come back for? A store with nothing outstanding schedules
  // nothing, which is the difference between a quiet queue and a daily no-op
  // per shop forever.
  const stillOpen = await db.quote.count({
    where: { status: "SENT", expiresAt: { not: null } },
  });

  if (stillOpen > 0) {
    await enqueueJob({
      kind: "quotes.expire",
      runAt: nextRun(now),
      replacePending: true,
    });
  }

  return { expired, reminded, examined: sent.length, requeued: stillOpen > 0 };
}

/**
 * The next run: tomorrow, just after midnight UTC.
 *
 * Expiry is a whole-day question, so checking hourly would be twenty-three
 * wasted runs. Just after midnight means a quote that runs out today is marked
 * expired within minutes of the date turning rather than a day late.
 */
export function nextRun(now: Date): Date {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5),
  );
  return next;
}

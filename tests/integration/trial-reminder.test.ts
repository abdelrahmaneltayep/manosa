import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { setEmailTransport } from "~/lib/email/send.server";
import {
  sendTrialReminder,
  TRIAL_REMINDER_DAYS,
} from "~/lib/jobs/handlers/trial-reminder.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

/**
 * "Your trial ends in three days", in a place the merchant will see it.
 *
 * Checklist §9 asks for this and it did not exist. The only warning was a
 * banner on the Plans page — the one page a merchant whose trial is ending is
 * least likely to be sitting on, and has no reason to open until something has
 * already gone wrong.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const NOW = new Date("2026-06-15T12:00:00Z");
const DAY = 86_400_000;

const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);

const sent: { to: string; subject: string; body: string }[] = [];

async function installTrial(shop: string, overrides: Record<string, unknown> = {}) {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        email: `owner@${shop}`,
        planKey: "growth",
        billingStatus: "TRIAL",
        billingInterval: "monthly",
        trialEndsAt: new Date(NOW.getTime() + 2 * DAY),
        ...overrides,
      },
    }),
  );
}

beforeEach(async () => {
  await resetDatabase();
  sent.length = 0;
  vi.stubEnv("SHOPIFY_APP_URL", "https://mannon.test");
  // `canSendEmail` wants both a transport and a from-address; without the
  // address `deliverEmail` records the message FAILED with the reason rather
  // than sending it, which is the behaviour a shop with no mail configured gets.
  vi.stubEnv("MANNON_EMAIL_FROM", "mannon@example.test");
  setEmailTransport({
    name: "test",
    send: async (email) => {
      sent.push({ to: email.to, subject: email.subject, body: email.body });
    },
  });
});

afterAll(async () => {
  setEmailTransport(null);
  await prismaBase.$disconnect();
});

describe("the trial-ending reminder", () => {
  it("writes to the merchant, with the date and what they will be charged", async () => {
    await installTrial(ALPHA);

    const result = await inAlpha(() => sendTrialReminder(NOW));
    expect(result).toMatchObject({ sent: true, daysLeft: 2 });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(`owner@${ALPHA}`);
    expect(sent[0]!.subject).toContain("2 days");
    expect(sent[0]!.body).toContain("$59 a month");
    // Nothing is deleted, said where the merchant is deciding.
    expect(sent[0]!.body).toContain("nothing");
    expect(sent[0]!.body).toContain("https://mannon.test/app/plans");
  });

  it("quotes the annual price to an annual trialist", async () => {
    // The in-app banner made exactly this mistake: "$99 a month" to somebody
    // about to be charged $990 once.
    await installTrial(ALPHA, { billingInterval: "annual", planKey: "agentic" });

    await inAlpha(() => sendTrialReminder(NOW));

    expect(sent[0]!.body).toContain("$990 for the year");
    expect(sent[0]!.body).not.toContain("a month");
  });

  it("sends once per trial", async () => {
    await installTrial(ALPHA);

    await inAlpha(() => sendTrialReminder(NOW));
    const second = await inAlpha(() => sendTrialReminder(new Date(NOW.getTime() + DAY)));

    expect(second).toEqual({ skipped: "already sent" });
    expect(sent).toHaveLength(1);
  });

  it("waits until the trial is close enough to be news", async () => {
    await installTrial(ALPHA, {
      trialEndsAt: new Date(NOW.getTime() + (TRIAL_REMINDER_DAYS + 5) * DAY),
    });

    expect(await inAlpha(() => sendTrialReminder(NOW))).toMatchObject({
      skipped: "too early",
    });
    expect(sent).toEqual([]);
  });

  it("re-queues itself whatever happens, so one bad day does not end the schedule", async () => {
    await installTrial(ALPHA, {
      trialEndsAt: new Date(NOW.getTime() + 30 * DAY),
    });

    await inAlpha(() => sendTrialReminder(NOW));

    const queued = await inAlpha(() =>
      db.scheduledJob.findMany({ where: { kind: "billing.trial_reminder" } }),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.runAt.getTime()).toBe(NOW.getTime() + DAY);
  });

  it("says nothing for a shop that is not in a trial", async () => {
    await installTrial(ALPHA, { billingStatus: "ACTIVE", trialEndsAt: null });

    expect(await inAlpha(() => sendTrialReminder(NOW))).toEqual({
      skipped: "not in a trial",
    });
    expect(sent).toEqual([]);
  });

  it("skips a shop with no address rather than retrying against one it does not have", async () => {
    await installTrial(ALPHA, { email: null });

    expect(await inAlpha(() => sendTrialReminder(NOW))).toEqual({
      skipped: "no address",
    });
    expect(sent).toEqual([]);
  });

  it("does nothing for a shop that has uninstalled", async () => {
    await installTrial(ALPHA, { uninstalledAt: NOW });

    expect(await inAlpha(() => sendTrialReminder(NOW))).toEqual({
      skipped: "uninstalled",
    });
  });

  it("writes to its own shop's owner and nobody else's", async () => {
    await installTrial(ALPHA);
    await installTrial(BETA);

    await inAlpha(() => sendTrialReminder(NOW));

    expect(sent.map((one) => one.to)).toEqual([`owner@${ALPHA}`]);
    const beta = await shopScope.run(BETA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: BETA } }),
    );
    expect(beta.trialReminderSentAt).toBeNull();
  });
});

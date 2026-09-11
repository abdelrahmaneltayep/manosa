import { beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import { cadenceFor, MIN_ORDERS_FOR_CADENCE } from "~/lib/customers/cadence.server";
import { greetingFor } from "~/lib/agent/buyer/greeting.server";
import { saveString } from "~/lib/i18n/strings.server";
import { GRACE_DAYS, riskFor, RISK_WINDOW } from "~/lib/terms/risk.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * Two chips the checklist asks for that had a prompt version and nothing else.
 *
 * Both are arithmetic on rows this app already stores, and Appendix B says the
 * model never computes what a deterministic module can. So the question every
 * test here asks is the one a merchant would: **on what?** A chip that grades
 * a buyer without saying what it counted is a judgement they cannot check.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const NOW = new Date("2026-09-11T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const BUYER = "gid://shopify/Customer/1";

let sequence = 0;
async function order(input: {
  at: Date;
  customerId?: string;
  dueAt?: Date | null;
  paidAt?: Date | null;
  total?: number;
  paid?: number;
  cancelled?: boolean;
  wholesale?: boolean;
}) {
  sequence += 1;
  await db.order.create({
    data: {
      ...tenant(),
      orderId: `gid://shopify/Order/${sequence}`,
      name: `#${sequence}`,
      customerId: input.customerId ?? BUYER,
      processedAt: input.at,
      currencyCode: "USD",
      totalPrice: input.total ?? 10_000,
      // `recordPayment` only stamps `paidAt` when the whole balance is in, so
      // a fixture that stamps it with nothing paid is a row this app cannot
      // write — and a test on a row the writer cannot produce is a test that
      // cannot fail. Mirrored here rather than hand-set per case.
      amountPaid: input.paid ?? (input.paidAt ? (input.total ?? 10_000) : 0),
      isWholesale: input.wholesale ?? true,
      cancelledAt: input.cancelled ? input.at : null,
      netTermsDueAt: input.dueAt ?? null,
      paidAt: input.paidAt ?? null,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  sequence = 0;
  await shopScope.run(ALPHA, () => db.shop.create({ data: { ...tenant() } }));
  await shopScope.run(BETA, () => db.shop.create({ data: { ...tenant() } }));
});

/* -------------------------------------------------------------------------- */

describe("when a buyer is due to order again", () => {
  it("says nothing about a buyer with no rhythm to read", async () => {
    await inAlpha(async () => {
      // Two orders is one interval, and one interval is not a rhythm. A chip
      // that fires on every second-time buyer is a chip a merchant learns to
      // ignore.
      await order({ at: daysAgo(60) });
      await order({ at: daysAgo(30) });

      expect(MIN_ORDERS_FOR_CADENCE).toBe(3);
      expect((await cadenceFor([BUYER], NOW)).get(BUYER)).toBeUndefined();
    });
  });

  it("fires once a buyer is past their own usual gap", async () => {
    await inAlpha(async () => {
      for (const days of [84, 63, 42, 21]) await order({ at: daysAgo(days) });

      const cadence = (await cadenceFor([BUYER], NOW)).get(BUYER)!;
      expect(cadence.everyDays).toBe(21);
      expect(cadence.daysSince).toBe(21);
      expect(cadence.due).toBe(true);
      // What it read the rhythm from, so the merchant can check it.
      expect(cadence.orders).toBe(4);
    });
  });

  it("stays quiet while a buyer is still inside their gap", async () => {
    await inAlpha(async () => {
      for (const days of [70, 49, 28, 7]) await order({ at: daysAgo(days) });

      const cadence = (await cadenceFor([BUYER], NOW)).get(BUYER)!;
      expect(cadence.everyDays).toBe(21);
      expect(cadence.due).toBe(false);
    });
  });

  it("is not dragged around by one unusual gap", async () => {
    await inAlpha(async () => {
      // A shutdown over a holiday: four ordinary weeks and one long one. A
      // mean would call this buyer's rhythm 45 days and stay silent for six
      // weeks after they were actually due.
      for (const days of [200, 179, 158, 137, 30, 9]) await order({ at: daysAgo(days) });

      const cadence = (await cadenceFor([BUYER], NOW)).get(BUYER)!;
      expect(cadence.everyDays).toBe(21);
    });
  });

  it("ignores cancelled orders, retail orders and two orders in one day", async () => {
    await inAlpha(async () => {
      for (const days of [63, 42, 21]) await order({ at: daysAgo(days) });
      // A split shipment on the same day is not a rhythm of nought days.
      await order({ at: daysAgo(21) });
      await order({ at: daysAgo(3), cancelled: true });
      await order({ at: daysAgo(2), wholesale: false });

      const cadence = (await cadenceFor([BUYER], NOW)).get(BUYER)!;
      expect(cadence.everyDays).toBe(21);
      expect(cadence.daysSince).toBe(21);
    });
  });

  it("reads one shop's orders and never another's", async () => {
    await shopScope.run(BETA, async () => {
      for (const days of [63, 42, 21]) await order({ at: daysAgo(days) });
    });

    await inAlpha(async () => {
      expect((await cadenceFor([BUYER], NOW)).size).toBe(0);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("how a buyer has paid before", () => {
  const due = (days: number) => daysAgo(days);

  it("says nothing about a buyer with no record", async () => {
    await inAlpha(async () => {
      // "Always pays on time" about a first invoice is a confident way of
      // saying nothing.
      await order({ at: daysAgo(5), dueAt: daysAgo(-25) });
      expect((await riskFor([BUYER], NOW)).get(BUYER)).toBeUndefined();
    });
  });

  it("counts an on-time streak, and says what it counted", async () => {
    await inAlpha(async () => {
      for (const days of [90, 60, 30]) {
        await order({ at: daysAgo(days + 30), dueAt: due(days), paidAt: due(days + 1) });
      }

      const risk = (await riskFor([BUYER], NOW)).get(BUYER)!;
      expect(risk.level).toBe("good");
      expect(risk.streak).toBe(3);
      expect(risk.settled).toBe(3);
      expect(risk.late).toBe(0);
    });
  });

  it("does not call a payment run a late payment", async () => {
    await inAlpha(async () => {
      await order({
        at: daysAgo(60),
        dueAt: due(30),
        paidAt: new Date(due(30).getTime() + GRACE_DAYS * DAY),
      });

      expect((await riskFor([BUYER], NOW)).get(BUYER)!.late).toBe(0);
    });
  });

  it("raises a watch on one late payment and a flag on two", async () => {
    await inAlpha(async () => {
      await order({
        at: daysAgo(90),
        dueAt: due(60),
        paidAt: new Date(due(60).getTime() + 10 * DAY),
      });
      await order({ at: daysAgo(60), dueAt: due(40), paidAt: due(41) });
      expect((await riskFor([BUYER], NOW)).get(BUYER)!.level).toBe("watch");

      await order({
        at: daysAgo(30),
        dueAt: due(20),
        paidAt: new Date(due(20).getTime() + 9 * DAY),
      });
      const risk = (await riskFor([BUYER], NOW)).get(BUYER)!;
      expect(risk.level).toBe("late");
      expect(risk.late).toBe(2);
      // The streak resets on the most recent late one, not on the oldest.
      expect(risk.streak).toBe(0);
    });
  });

  it("counts something overdue right now, whatever the history says", async () => {
    await inAlpha(async () => {
      for (const days of [120, 90, 60]) {
        await order({ at: daysAgo(days + 30), dueAt: due(days), paidAt: due(days + 1) });
      }
      await order({ at: daysAgo(40), dueAt: due(10), paidAt: null });

      const risk = (await riskFor([BUYER], NOW)).get(BUYER)!;
      expect(risk.overdueNow).toBe(1);
      // Three on-time payments do not make a currently-overdue invoice fine.
      expect(risk.level).toBe("late");
    });
  });

  it("does not count a part-paid invoice as settled", async () => {
    await inAlpha(async () => {
      // What `recordPayment` actually writes for a part payment: money in,
      // `paidAt` still null, balance still owed. Counting it as paid on time
      // would tell a merchant they have been settled with while they are owed
      // 60% of it.
      await order({
        at: daysAgo(60),
        dueAt: due(30),
        paidAt: null,
        total: 10_000,
        paid: 4_000,
      });

      const risk = (await riskFor([BUYER], NOW)).get(BUYER)!;
      expect(risk.settled).toBe(0);
      expect(risk.overdueNow).toBe(1);
      expect(risk.level).toBe("late");
    });
  });

  it("reads only as far back as it says it does", async () => {
    await inAlpha(async () => {
      for (let at = 0; at < RISK_WINDOW + 4; at += 1) {
        await order({
          at: daysAgo(400 - at * 10),
          dueAt: due(380 - at * 10),
          paidAt: due(381 - at * 10),
        });
      }

      expect((await riskFor([BUYER], NOW)).get(BUYER)!.settled).toBe(RISK_WINDOW);
    });
  });

  it("reads one shop's ledger and never another's", async () => {
    await shopScope.run(BETA, async () => {
      await order({ at: daysAgo(60), dueAt: due(30), paidAt: due(29) });
    });

    await inAlpha(async () => {
      expect((await riskFor([BUYER], NOW)).size).toBe(0);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("what the widget says before a buyer has said anything", () => {
  const BUYER_ROW = {
    customerId: BUYER,
    firstName: "Dana",
    company: "Acme Ltd",
    email: "dana@acme.test",
  };

  it("names them, their tier and their last order", async () => {
    await inAlpha(async () => {
      const group = await db.customerGroup.create({
        data: { ...tenant(), name: "Gold", handle: "gold", tag: "wholesale:gold" },
      });
      await db.customer.create({
        data: {
          ...tenant(),
          ...BUYER_ROW,
          groupId: group.id,
          orderCount: 4,
          lastOrderAt: daysAgo(3),
        },
      });

      // 5.2 shipped the name alone, because the theme block reads Liquid and
      // Liquid knows nothing else. The checklist asks for all three.
      const greeting = await greetingFor(BUYER, "en", NOW);
      expect(greeting!.text).toContain("Dana");
      expect(greeting!.text).toContain("Gold");
      expect(greeting!.text).toContain("3 days ago");
    });
  });

  it("says nothing about a tier a buyer is not in", async () => {
    await inAlpha(async () => {
      await db.customer.create({
        data: { ...tenant(), ...BUYER_ROW, orderCount: 0, lastOrderAt: null },
      });

      // A buyer priced by their tags alone has no tier, and inventing
      // "Standard" would name a group the merchant never made.
      const greeting = await greetingFor(BUYER, "en", NOW);
      expect(greeting!.text).toContain("Dana");
      expect(greeting!.text).not.toContain("pricing");
      expect(greeting!.text).toContain("first order");
    });
  });

  it("is nothing at all for somebody this shop has never seen", async () => {
    await inAlpha(async () => {
      expect(await greetingFor("gid://shopify/Customer/999", "en", NOW)).toBeNull();
    });
  });

  it("is the merchant's own wording when they have rewritten it", async () => {
    await inAlpha(async () => {
      await db.customer.create({
        data: { ...tenant(), ...BUYER_ROW, orderCount: 0, lastOrderAt: null },
      });
      await saveString(
        {
          key: "agent.scripted.greetingNamed",
          locale: "en",
          value: "Welcome back, {{name}}!",
        },
        { actor: { type: "STAFF", id: "staff-1" } },
      );

      // The greeting is a buyer-facing string, so it goes through the same `t`
      // as every other one — which is the whole of 6.6 working.
      expect((await greetingFor(BUYER, "en", NOW))!.text).toContain(
        "Welcome back, Dana!",
      );
    });
  });

  it("reads one shop's buyer and never another's", async () => {
    await shopScope.run(BETA, async () => {
      await db.customer.create({
        data: { ...tenant(), ...BUYER_ROW, orderCount: 2, lastOrderAt: daysAgo(1) },
      });
    });

    await inAlpha(async () => {
      expect(await greetingFor(BUYER, "en", NOW)).toBeNull();
    });
  });
});

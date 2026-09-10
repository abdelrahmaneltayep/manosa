import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { resetAnthropicClient } from "~/lib/ai/client.server";
import { buildView } from "~/lib/agent/home-view.server";
import { muteKind, unmuteKind } from "~/lib/agent/briefing.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * What the home page actually says.
 *
 * The screen is a pure function of this view, so every sentence a merchant
 * reads on Home is decided here — including the four different ways of saying
 * "the agent has nothing for you", which are four different truths and were
 * one sentence until a merchant was told "All quiet" with six applications
 * waiting.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date();
const DAY = 86_400_000;

const request = (url = "https://mannon.test/app") => new Request(url);

async function installShop(shop: string, planKey = "agentic") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        primaryLocale: "en",
        name: "Acme Wholesale",
      },
    }),
  );
}

/** Six applications waiting: a fact the briefing can be written about. */
async function applications(count: number) {
  const form = await db.registrationForm.create({
    data: {
      ...tenant(),
      name: "Trade application",
      slug: "trade",
      status: "LIVE",
      fields: [],
      appearance: {},
      emails: {},
      publish: {},
    },
  });

  for (let index = 0; index < count; index += 1) {
    await db.formSubmission.create({
      data: {
        ...tenant(),
        formId: form.id,
        status: "PENDING",
        email: `buyer${index}@acme.test`,
        company: `Acme ${index}`,
        answers: {},
      },
    });
  }
}

const briefingWritten = (kinds: string[], generatedAt = NOW) =>
  db.merchantBriefing.create({
    data: {
      ...tenant(),
      items: kinds.map((kind) => ({ kind, reason: "Someone is waiting on you." })),
      quiet: kinds.length === 0,
      generatedAt,
      aiModel: "claude-sonnet-4-5",
      aiPromptVersion: "briefing/1",
      aiRequestId: "req_1",
    },
  });

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  resetAnthropicClient();
});

afterAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  resetAnthropicClient();
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */

describe("which briefing card is shown", () => {
  it("introduces itself on day one", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const view = await buildView(request());
      expect(view.briefing.status).toBe("empty");
      expect(view.briefing.writtenAt).toBeNull();
      expect(view.briefing.writtenAtLabel).toBeNull();
      expect(view.shopName).toBe("Acme Wholesale");
    });
  });

  it("shows this morning's items with today's figures", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await applications(6);
      await briefingWritten(["applications_waiting"]);

      const view = await buildView(request());
      expect(view.briefing.status).toBe("ready");
      expect(view.briefing.items).toHaveLength(1);
      // Our number, recomputed — not one the model wrote down this morning.
      expect(view.briefing.items[0]?.figure).toBe("6 applications");
      expect(view.briefing.items[0]?.href).toBe("/app/customers/applications");
      expect(view.briefing.items[0]?.reason).not.toMatch(/\d/);
    });
  });

  it("drops an item the merchant dealt with overnight", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await briefingWritten(["applications_waiting"]);

      const view = await buildView(request());
      // Nothing is waiting any more, so the line asking them to review it is
      // gone. Not "All quiet": a shop with no live pricing rules always has
      // something outstanding, and this shop has none.
      expect(view.briefing.items).toEqual([]);
      expect(view.briefing.status).toBe("cleared");
    });
  });

  it("says the list is done, not that all is quiet, when something else came up", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      // Written about something now dealt with; six applications have since
      // arrived and no briefing has been written about them yet.
      await briefingWritten(["invoices_overdue"]);
      await applications(6);

      const view = await buildView(request());
      expect(view.briefing.status).toBe("cleared");
      expect(view.briefing.items).toEqual([]);
    });
  });

  it("says today's could not be written, and shows the last one", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await applications(6);
      await briefingWritten(["applications_waiting"], new Date(NOW.getTime() - DAY * 2));
      await db.shop.update({
        where: { shop: ALPHA },
        data: { briefingFailedAt: NOW, briefingFailedReason: "timeout" },
      });

      const view = await buildView(request());
      expect(view.briefing.status).toBe("unavailable");
      // Yesterday's list, with figures that are current.
      expect(view.briefing.items).toHaveLength(1);
      expect(view.briefing.stale).toBe(true);
      expect(view.briefing.writtenAtLabel).not.toBeNull();
    });
  });

  it("stops apologising once a briefing lands", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await db.shop.update({
        where: { shop: ALPHA },
        data: {
          briefingFailedAt: new Date(NOW.getTime() - DAY),
          briefingFailedReason: "timeout",
        },
      });
      await briefingWritten([]);

      // The card that matters is that it is no longer apologising.
      expect((await buildView(request())).briefing.status).not.toBe("unavailable");
    });
  });
});

describe("when the agent is off", () => {
  it("says so, and shows no model prose, with no key", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await applications(6);
      await briefingWritten(["applications_waiting"]);

      delete process.env.ANTHROPIC_API_KEY;
      resetAnthropicClient();

      const view = await buildView(request());
      expect(view.briefing.status).toBe("off");
      expect(view.briefing.items).toEqual([]);
      expect(view.ask.available).toBe(false);
    });
  });

  it("says so on a plan without the Merchant Agent", async () => {
    await installShop(ALPHA, "pro");

    await inAlpha(async () => {
      await applications(6);
      await briefingWritten(["applications_waiting"]);

      const view = await buildView(request());
      expect(view.briefing.status).toBe("off");
      expect(view.briefing.items).toEqual([]);
    });
  });
});

describe("muting a kind", () => {
  it("takes it off the list and offers a way back", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await applications(6);
      await briefingWritten(["applications_waiting"]);
      await muteKind("applications_waiting", "staff-1");

      const muted = await buildView(request());
      expect(muted.briefing.items).toEqual([]);
      expect(muted.briefing.muted).toEqual([
        { kind: "applications_waiting", label: "Applications waiting" },
      ]);
      // Muted, not dealt with: saying "All quiet" here would be a lie about
      // six people who are still waiting.
      expect(muted.briefing.status).toBe("cleared");

      await unmuteKind("applications_waiting", "staff-1");
      const back = await buildView(request());
      expect(back.briefing.muted).toEqual([]);
      expect(back.briefing.items).toHaveLength(1);

      // Both directions are on the record. A merchant who finds an item
      // missing can see who silenced it and when.
      const audit = await db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
      expect(audit.map((entry) => entry.action)).toEqual([
        "briefing.muted",
        "briefing.unmuted",
      ]);
      expect(audit.every((entry) => entry.actorId === "staff-1")).toBe(true);
    });
  });

  it("asks before it mutes, and only about a kind it knows", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const asked = await buildView(
        request("https://mannon.test/app?confirm=rules_unused"),
      );
      expect(asked.briefing.confirmingMute).toBe("rules_unused");

      // A hand-typed query string does not become a heading.
      const nonsense = await buildView(
        request("https://mannon.test/app?confirm=%3Cscript%3E"),
      );
      expect(nonsense.briefing.confirmingMute).toBeNull();
    });
  });

  it("refuses a kind that is not one of ours", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await expect(muteKind("everything", "staff-1")).rejects.toBeInstanceOf(Response);
      await expect(unmuteKind("everything", "staff-1")).rejects.toBeInstanceOf(Response);
      expect((await buildView(request())).briefing.muted).toEqual([]);
    });
  });
});

describe("across shops", () => {
  it("never shows one shop's briefing or facts to another", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await applications(6);
      await briefingWritten(["applications_waiting"]);
    });

    await inAlpha(async () => {
      const view = await buildView(request());
      expect(view.briefing.status).toBe("empty");
      expect(view.briefing.items).toEqual([]);
    });
  });

  it("does not carry a mute across shops", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(() => muteKind("applications_waiting", "staff-1"));

    await inAlpha(async () => {
      await applications(6);
      await briefingWritten(["applications_waiting"]);
      const view = await buildView(request());
      expect(view.briefing.muted).toEqual([]);
      expect(view.briefing.items).toHaveLength(1);
    });
  });
});

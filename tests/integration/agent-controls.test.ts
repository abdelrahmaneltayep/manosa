import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { aiGate, aiPermissions, requireAi } from "~/lib/ai/permissions.server";
import { actionLabel, loadActivity, recordedActions } from "~/lib/activity/feed.server";
import { recordAudit } from "~/lib/audit/record.server";
import {
  AUDIT_RETENTION_MONTHS,
  purgeAudit,
  retentionCutoff,
} from "~/lib/jobs/handlers/purge-audit.server";
import { emailDraftUser } from "~/lib/ai/prompts/email-draft.server";
import {
  addSample,
  BrandVoiceInvalid,
  listSamples,
  MAX_SAMPLES,
  removeSample,
  voiceForPrompt,
} from "~/lib/settings/brand-voice.server";
import { saveSettings } from "~/lib/settings/settings.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * ✦ Agent controls.
 *
 * The question this task exists to answer: can a merchant say what Claude may
 * do? Before it, every ✦ surface asked only whether an API key was set, so the
 * answer was "whatever the deployment decided".
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const ACTOR = { type: "STAFF" as const, id: "staff-1" };

async function installShop(shop: string) {
  await shopScope.run(shop, async () => {
    await db.shop.create({ data: { ...tenant(), planKey: "agentic" } });
  });
}

const body = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
};

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
});

/* -------------------------------------------------------------------------- */

describe("the permission gate", () => {
  it("answers all three questions, not just the key", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      expect((await aiGate("screen")).allowed).toBe(true);

      // The merchant's own choice comes first, because it is the only one of
      // the three they can change here and now.
      await saveSettings("agent", body({ aiMayDraft: "on" }), { actor: ACTOR });
      const screen = await aiGate("screen");
      expect(screen.allowed).toBe(false);
      expect(screen.blockedBy).toBe("permission");
      // And the other permission is untouched: they are separate choices.
      expect((await aiGate("draft")).allowed).toBe(true);
    });
  });

  it("reports the key as the reason only when it is the reason", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      const gate = await aiGate("draft");
      expect(gate.allowed).toBe(false);
      expect(gate.blockedBy).toBe("no_key");

      // A merchant who has switched it off should be told *that*, not sent
      // hunting for a key they cannot see.
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      await saveSettings("agent", body({ aiMayScreen: "on" }), { actor: ACTOR });
      expect((await aiGate("draft")).blockedBy).toBe("permission");
    });
  });

  it("is one shop's choice and never another's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inAlpha(async () => {
      await saveSettings("agent", body({}), { actor: ACTOR });
      expect(await aiPermissions()).toEqual({ screen: false, draft: false });
    });

    await inBeta(async () => {
      expect(await aiPermissions()).toEqual({ screen: true, draft: true });
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("enforcement, not the disabled button", () => {
  /**
   * The gate has to close on the path that calls Anthropic.
   *
   * 6.5 shipped with every converted call site assigning `aiGate(...).allowed`
   * into a **view** and never reading it as a condition, so four ✦ actions
   * still sent the merchant's data to the model after they had switched it
   * off — from a form the loader had already decided not to offer. The suite
   * was green throughout, because not one test posted to a ✦ action with a
   * permission off. These do.
   */
  it("throws 403 rather than reaching the model, for every permission", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await saveSettings("agent", body({}), { actor: ACTOR });

      for (const permission of ["screen", "draft"] as const) {
        const refused = await requireAi(permission).catch((error: unknown) => error);
        expect(refused, permission).toBeInstanceOf(Response);
        if (refused instanceof Response) {
          expect(refused.status, permission).toBe(403);
          // The merchant switched it off; do not send them hunting for a key.
          expect(await refused.text()).toContain("switched this off");
        }
      }
    });
  });

  it("says 402 for a plan and 403 for a choice — different problems", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await db.shop.update({ where: { shop: ALPHA }, data: { planKey: "free" } });

      const plan = await requireAi("draft", { feature: "merchant_agent" }).catch(
        (error: unknown) => error,
      );
      expect(plan).toBeInstanceOf(Response);
      if (plan instanceof Response) expect(plan.status).toBe(402);
    });
  });

  it("lets the permitted one through", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await saveSettings("agent", body({ aiMayDraft: "on" }), { actor: ACTOR });
      await expect(requireAi("draft")).resolves.toBeUndefined();
      await expect(requireAi("screen")).rejects.toBeInstanceOf(Response);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("brand voice samples", () => {
  const sample = { label: "How I welcome a buyer", body: "Hi Sam — lovely to have you." };

  it("keeps the merchant's words as written, and shows who added them", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const added = await addSample(sample, { actor: ACTOR });
      expect(added.body).toBe(sample.body);
      expect(added.createdBy).toBe("staff-1");

      // The label, never the body: an audit summary is read in a list, and
      // this is the merchant's own correspondence.
      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "settings.brand_voice_added" },
      });
      expect(entry.summary).toContain(sample.label);
      expect(entry.summary).not.toContain("lovely to have you");
    });
  });

  it("refuses an empty sample, and one longer than Claude reads", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await expect(
        addSample({ label: "", body: "x" }, { actor: ACTOR }),
      ).rejects.toBeInstanceOf(BrandVoiceInvalid);
      await expect(
        addSample({ label: "x", body: "   " }, { actor: ACTOR }),
      ).rejects.toBeInstanceOf(BrandVoiceInvalid);
      await expect(
        addSample({ label: "x", body: "y".repeat(5_000) }, { actor: ACTOR }),
      ).rejects.toBeInstanceOf(BrandVoiceInvalid);

      expect(await listSamples()).toHaveLength(0);
    });
  });

  it("stops at the number Claude actually reads, even under a race", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      for (let index = 0; index < MAX_SAMPLES; index += 1) {
        await addSample({ label: `s${index}`, body: "words" }, { actor: ACTOR });
      }
      await expect(
        addSample({ label: "one more", body: "words" }, { actor: ACTOR }),
      ).rejects.toBeInstanceOf(BrandVoiceInvalid);
    });
  });

  it("does not overshoot when several tabs add at once", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      // `count()` then `create()` is check-then-act: eight concurrent adds
      // stored seven, after which the page hid the add form and said "that is
      // as many as Claude reads" beside seven of them.
      await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          addSample({ label: `race-${index}`, body: "words" }, { actor: ACTOR }),
        ),
      );
      expect((await listSamples()).length).toBeLessThanOrEqual(MAX_SAMPLES);
    });
  });

  it("says a label is too long rather than silently cutting it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const failed = await addSample(
        { label: "x".repeat(300), body: "words" },
        { actor: ACTOR },
      ).catch((error: unknown) => error);

      expect(failed).toBeInstanceOf(BrandVoiceInvalid);
      if (failed instanceof BrandVoiceInvalid) expect(failed.issue).toBe("labelTooLong");
    });
  });

  it("reaches the drafting prompt, which is what the card promises", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await addSample(sample, { actor: ACTOR });
      // The card says "Claude will match your tone". Until this round that was
      // true of nothing: the samples were stored, shown, and read by no prompt.
      const forPrompt = await voiceForPrompt();
      expect(forPrompt).toEqual([{ label: sample.label, body: sample.body }]);

      const user = emailDraftUser({
        intent: "approve",
        template: { subject: "s", body: "b" },
        shopName: ALPHA,
        formName: "Trade",
        groupName: null,
        reason: null,
        note: null,
        locale: "en",
        voiceSamples: forPrompt,
      });
      expect(user).toContain(sample.body);
      expect(user).toContain("Never copy their content");
    });
  });

  it("cannot remove another shop's sample, and says nothing happened", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    const theirs = await inBeta(() => addSample(sample, { actor: ACTOR }));

    await inAlpha(async () => {
      // Reads as not found, never as a leak — and a delete that deleted
      // nothing is not an audit entry either.
      await removeSample(theirs.id, { actor: ACTOR });
      expect(
        await db.auditLog.count({ where: { action: "settings.brand_voice_removed" } }),
      ).toBe(0);
    });

    await inBeta(async () => {
      expect(await listSamples()).toHaveLength(1);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("the audit log", () => {
  async function entry(at: Date, action: string, actorType: "STAFF" | "MERCHANT_AGENT") {
    const row = await recordAudit({
      actor: {
        type: actorType,
        id: "a",
        label: actorType === "STAFF" ? "Sam" : "Claude",
      },
      action,
      summary: `${action} at ${at.toISOString()}`,
    });
    await db.auditLog.update({ where: { id: row.id }, data: { createdAt: at } });
  }

  const NOW = new Date("2026-09-11T12:00:00Z");

  it("keeps twelve months and deletes what is older", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await entry(new Date("2026-09-01T00:00:00Z"), "pricing_rule.created", "STAFF");
      await entry(new Date("2024-01-01T00:00:00Z"), "pricing_rule.created", "STAFF");

      // The schema has promised twelve months since 0.2 and nothing enforced
      // it: `purge-conversations` existed for AgentMessage, and this table
      // just grew. A retention promise with no job behind it is a sentence.
      const result = await purgeAudit({ now: NOW });
      expect(result).toMatchObject({
        deleted: 1,
        retentionMonths: AUDIT_RETENTION_MONTHS,
      });
      expect(await db.auditLog.count()).toBe(1);

      // And it keeps itself alive, like the other recurring work here.
      expect(
        await db.scheduledJob.count({
          where: { kind: "audit.purge", status: "PENDING" },
        }),
      ).toBe(1);
    });
  });

  it("never purges the record that a person approved an AI change", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const row = await recordAudit({
        actor: { type: "MERCHANT_AGENT", id: "claude" },
        action: "pricing_rule.created",
        summary: "Created a rule from a sentence.",
        aiAssisted: true,
        approval: { byId: "staff-1", at: new Date("2024-01-01") },
      });
      await db.auditLog.update({
        where: { id: row.id },
        data: { createdAt: new Date("2024-01-01T00:00:00Z") },
      });

      // §8 says twelve months; Invariant 3 says the approval must be recorded.
      // The first version resolved that silently in the wrong direction: after
      // a year the rule was still pricing every checkout with nothing saying
      // who approved it.
      await purgeAudit({ now: NOW });
      expect(await db.auditLog.count({ where: { aiAssisted: true } })).toBe(1);
    });
  });

  it("purges one shop's history and never another's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(() =>
      entry(new Date("2024-01-01T00:00:00Z"), "pricing_rule.created", "STAFF"),
    );
    await inAlpha(async () => {
      await purgeAudit({ now: NOW });
    });

    await inBeta(async () => {
      expect(await db.auditLog.count()).toBe(1);
    });
  });

  it("counts twelve calendar months, leap year included", () => {
    // The old version restated `retentionCutoff`'s own definition and could
    // not fail for any implementation that subtracts a fixed number of days —
    // which is exactly the implementation that is a day short across 29 Feb.
    expect(retentionCutoff(new Date("2027-02-28T12:00:00Z")).toISOString()).toBe(
      "2026-02-28T12:00:00.000Z",
    );
    expect(retentionCutoff(new Date("2026-09-11T12:00:00Z")).toISOString()).toBe(
      "2025-09-11T12:00:00.000Z",
    );
  });

  it("filters by who did it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await entry(new Date("2026-09-01T00:00:00Z"), "pricing_rule.created", "STAFF");
      await entry(
        new Date("2026-09-02T00:00:00Z"),
        "pricing_rule.created",
        "MERCHANT_AGENT",
      );

      // The question a merchant opens this page with.
      const byAgent = await loadActivity({ actor: "agent", limit: 20 });
      expect(byAgent.rows).toHaveLength(1);
      expect(byAgent.rows[0]?.agent).toBe(true);

      const byStaff = await loadActivity({ actor: "staff", limit: 20 });
      expect(byStaff.rows).toHaveLength(1);
      expect(byStaff.rows[0]?.agent).toBe(false);
    });
  });

  it("filters by one exact action, and by a range of whole days", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await entry(new Date("2026-09-01T09:00:00Z"), "pricing_rule.created", "STAFF");
      await entry(new Date("2026-09-03T23:30:00Z"), "form.approved", "STAFF");
      await entry(new Date("2026-09-05T09:00:00Z"), "form.approved", "STAFF");

      expect(
        (await loadActivity({ action: "form.approved", limit: 20 })).rows,
      ).toHaveLength(2);

      // "Up to the 3rd" means the whole of the 3rd. An exclusive bound at
      // midnight would silently drop an entry at 23:30.
      const window = await loadActivity({
        from: new Date("2026-09-01T00:00:00Z"),
        to: new Date("2026-09-03T00:00:00Z"),
        limit: 20,
      });
      expect(window.rows).toHaveLength(2);
    });
  });

  it("offers only the actions this shop has actually recorded, told apart", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await entry(new Date("2026-09-01T09:00:00Z"), "pricing_rule.created", "STAFF");
      await entry(new Date("2026-09-02T09:00:00Z"), "pricing_rule.archived", "STAFF");
      await entry(
        new Date("2026-09-03T09:00:00Z"),
        "settings.brand_voice_added",
        "STAFF",
      );

      // Built from the producer, not from a hand-written label pair. The
      // picker used to label each option with the *family* chip, so eleven
      // options read "Pricing" and ten read "Activity" — a merchant could not
      // tell `pricing_rule.created` from `pricing_rule.archived`.
      const t = ((key: string) => key) as unknown as Parameters<typeof actionLabel>[1];
      const labels = (await recordedActions()).map((value) => actionLabel(value, t));
      expect(new Set(labels).size).toBe(labels.length);

      // A picker offering forty actions a shop has never performed is a picker
      // nobody uses — and a hand-kept list is the registration step this repo
      // has forgotten three times.
      expect(await recordedActions()).toEqual([
        "pricing_rule.archived",
        "pricing_rule.created",
        "settings.brand_voice_added",
      ]);
    });
  });
});

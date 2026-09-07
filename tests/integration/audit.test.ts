import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import {
  MissingApprovalError,
  recordAudit,
  SYSTEM_ACTOR,
} from "~/lib/audit/record.server";
import { MissingShopContextError, shopScope } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("audit writer", () => {
  it("writes an entry for the active tenant", async () => {
    await shopScope.run(ALPHA, () =>
      recordAudit({
        actor: { type: "STAFF", id: "gid://shopify/StaffMember/1", label: "Dana" },
        action: "pricing_rule.created",
        summary: "Created the rule “Gold tier”.",
        subject: { type: "PricingRule", id: "rule_1" },
        metadata: { tiers: 3 },
      }),
    );

    const entry = await shopScope.run(ALPHA, () => db.auditLog.findFirstOrThrow());
    expect(entry.shop).toBe(ALPHA);
    expect(entry.actorLabel).toBe("Dana");
    expect(entry.action).toBe("pricing_rule.created");
    expect(entry.subjectId).toBe("rule_1");
    expect(entry.aiAssisted).toBe(false);
  });

  it("refuses to write outside a tenant context", async () => {
    await expect(
      recordAudit({ actor: SYSTEM_ACTOR, action: "test", summary: "no tenant" }),
    ).rejects.toBeInstanceOf(MissingShopContextError);
  });

  it("keeps one shop's log out of another's", async () => {
    await shopScope.run(ALPHA, () =>
      recordAudit({ actor: SYSTEM_ACTOR, action: "app.installed", summary: "alpha" }),
    );
    await shopScope.run(BETA, () =>
      recordAudit({ actor: SYSTEM_ACTOR, action: "app.installed", summary: "beta" }),
    );

    const fromBeta = await shopScope.run(BETA, () => db.auditLog.findMany());
    expect(fromBeta.map((row) => row.summary)).toEqual(["beta"]);
  });

  it("records AI provenance alongside the action", async () => {
    await shopScope.run(ALPHA, () =>
      recordAudit({
        actor: { type: "MERCHANT_AGENT", label: "Claude" },
        action: "ai.rule.drafted",
        summary: "Drafted a volume tier rule from a sentence.",
        ai: {
          model: "claude-sonnet-4-5",
          promptVersion: "rule-from-sentence@1",
          requestId: "req_123",
        },
      }),
    );

    const entry = await shopScope.run(ALPHA, () => db.auditLog.findFirstOrThrow());
    expect(entry.aiModel).toBe("claude-sonnet-4-5");
    expect(entry.aiPromptVersion).toBe("rule-from-sentence@1");
  });
});

describe("the approval invariant", () => {
  it("refuses an AI-assisted mutation with no approver", async () => {
    await expect(
      shopScope.run(ALPHA, () =>
        recordAudit({
          actor: { type: "MERCHANT_AGENT", label: "Claude" },
          action: "pricing_rule.activated",
          summary: "Activated a rule Claude drafted.",
          ai: { model: "claude-sonnet-4-5", promptVersion: "v1" },
          aiAssisted: true,
        }),
      ),
    ).rejects.toBeInstanceOf(MissingApprovalError);

    const count = await shopScope.run(ALPHA, () => db.auditLog.count());
    expect(count).toBe(0);
  });

  it("accepts an AI-assisted mutation that names its approver", async () => {
    await shopScope.run(ALPHA, () =>
      recordAudit({
        actor: { type: "MERCHANT_AGENT", label: "Claude" },
        action: "pricing_rule.activated",
        summary: "Activated a rule Claude drafted.",
        ai: { model: "claude-sonnet-4-5", promptVersion: "v1" },
        aiAssisted: true,
        approval: { byId: "gid://shopify/StaffMember/1" },
      }),
    );

    const entry = await shopScope.run(ALPHA, () => db.auditLog.findFirstOrThrow());
    expect(entry.aiAssisted).toBe(true);
    expect(entry.approvedById).toBe("gid://shopify/StaffMember/1");
    expect(entry.approvedAt).toBeInstanceOf(Date);
  });

  it("enlists in the caller's transaction, so a failed mutation logs nothing", async () => {
    await expect(
      shopScope.run(ALPHA, () =>
        db.$transaction(async (tx) => {
          await recordAudit(
            { actor: SYSTEM_ACTOR, action: "shop.updated", summary: "in a transaction" },
            tx,
          );
          throw new Error("the mutation failed after the audit write");
        }),
      ),
    ).rejects.toThrow(/the mutation failed/);

    const count = await shopScope.run(ALPHA, () => db.auditLog.count());
    expect(count).toBe(0);
  });
});

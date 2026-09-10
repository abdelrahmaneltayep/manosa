import { describe, expect, it } from "vitest";

import type { Translate } from "~/i18n/translate";
import {
  readNamedDraft,
  type RuleGrounding,
} from "~/lib/ai/prompts/rule-from-sentence.server";
import { describeView, draftCard, marginView } from "~/lib/pricing/describe-view.server";
import {
  builderFields,
  decodeDraft,
  encodeDraft,
  envelopeFor,
  prepareDraft,
  type DraftEnvelope,
} from "~/lib/pricing/describe.server";
import type { MarginGuardResult } from "~/lib/pricing/margin-guard.server";
import { parseRuleForm } from "~/lib/pricing/rule-form.server";

/**
 * The draft round trip.
 *
 * A draft lives in a hidden field, so everything that comes back has to be
 * re-read defensively and everything that goes out has to survive the trip. The
 * property that matters most is the last one: the fields "Edit" hands the
 * manual builder must parse back into the same rule, or the builder silently
 * opens with something else.
 */

const NOW = new Date("2026-09-10T12:00:00Z");

const grounding: RuleGrounding = {
  currencyCode: "USD",
  collections: [
    { id: "gid://shopify/Collection/1", title: "Sale" },
    { id: "gid://shopify/Collection/9", title: "Tables" },
  ],
  groups: [{ id: "grp_gold", name: "Gold" }],
  tags: ["wholesale"],
};

const provenance = {
  model: "claude-sonnet-4-5",
  promptVersion: "1",
  requestId: "msg_01test",
};

const answer = (overrides: Record<string, unknown> = {}) => ({
  name: "Wholesale tiers",
  kind: "volume_tier",
  tiers: [
    { minQuantity: 10, maxQuantity: 49, kind: "percentage", percentage: 5 },
    { minQuantity: 50, maxQuantity: null, kind: "percentage", percentage: 12 },
  ],
  cartTiers: [],
  targets: { mode: "all", collections: [], excludeCollections: ["Sale"] },
  audience: { mode: "tags", tags: ["wholesale"], groups: [] },
  schedule: { startsAt: null, endsAt: null },
  combinable: false,
  notes: "Excluded sale items as asked.",
  ...overrides,
});

function draftOf(overrides: Record<string, unknown> = {}) {
  const read = readNamedDraft(answer(overrides), grounding, NOW);
  if (!read.ok) throw new Error(read.error);
  return read.value;
}

const envelope = (overrides: Record<string, unknown> = {}) =>
  envelopeFor("Buy 10 get 5%, buy 50 get 12%", draftOf(overrides), provenance);

/** A translator that returns the key, so a missing key is visible in a test. */
const t: Translate = (key, params) =>
  params ? `${key}(${Object.values(params).join(",")})` : key;

/* -------------------------------------------------------------------------- */

describe("the draft envelope", () => {
  it("survives a round trip", () => {
    const read = decodeDraft(encodeDraft(envelope()));

    expect(read?.sentence).toBe("Buy 10 get 5%, buy 50 get 12%");
    expect(read?.provenance).toEqual(provenance);
    expect(read?.notes).toContain("Excluded sale items");
  });

  it("comes back as the same rule", () => {
    const original = envelope();
    const read = decodeDraft(encodeDraft(original));
    const prepared = prepareDraft(read!, grounding, NOW);

    expect(prepared.rule.targets.excludeCollectionIds).toEqual([
      "gid://shopify/Collection/1",
    ]);
    expect(prepared.clarifications).toEqual([]);
  });

  it("refuses anything unreadable rather than throwing", () => {
    expect(decodeDraft(null)).toBeNull();
    expect(decodeDraft("")).toBeNull();
    expect(decodeDraft("not json")).toBeNull();
    expect(decodeDraft("[]")).toBeNull();
    expect(decodeDraft('"a string"')).toBeNull();
    expect(decodeDraft("{}")).toBeNull();
  });

  it("refuses a payload whose rule has been tampered into nonsense", () => {
    const broken = { ...envelope(), rule: { id: "draft", name: 7 } };
    expect(decodeDraft(JSON.stringify(broken))).toBeNull();
  });

  it("refuses a payload with no provenance, which would forge the audit entry", () => {
    const { provenance: _dropped, ...rest } = envelope();
    expect(decodeDraft(JSON.stringify(rest))).toBeNull();
  });

  it("drops choices that are not strings", () => {
    // Hand-built rather than typed: the point is a payload no honest client
    // would send, which is exactly what the type system cannot describe.
    const tampered = {
      ...envelope(),
      choices: { Sale: 42, Tables: "gid://shopify/Collection/9" },
    };
    const read = decodeDraft(JSON.stringify(tampered));

    expect(read?.choices).toEqual({ Tables: "gid://shopify/Collection/9" });
  });

  it("carries a merchant's answers across the trip", () => {
    const answered: DraftEnvelope = {
      ...envelope({ targets: { mode: "collections", collections: ["desks"] } }),
      choices: { desks: "gid://shopify/Collection/9" },
    };
    const prepared = prepareDraft(decodeDraft(encodeDraft(answered))!, grounding, NOW);

    expect(prepared.rule.targets.collectionIds).toEqual(["gid://shopify/Collection/9"]);
    expect(prepared.clarifications).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("handing the draft to the manual builder", () => {
  const asFormData = (fields: { name: string; value: string }[]) => {
    const form = new FormData();
    for (const field of fields) form.append(field.name, field.value);
    return form;
  };

  it("parses back into the same rule", () => {
    const prepared = prepareDraft(envelope(), grounding, NOW);
    const parsed = parseRuleForm(asFormData(builderFields(prepared.rule, "USD")), {
      currencyCode: "USD",
    });

    expect(parsed.issues).toEqual([]);
    expect(parsed.unreadable).toEqual([]);
    expect(parsed.rule.name).toBe(prepared.rule.name);
    expect(parsed.rule.kind).toBe(prepared.rule.kind);
    expect(parsed.rule.value).toEqual(prepared.rule.value);
    expect(parsed.rule.targets.excludeCollectionIds).toEqual(
      prepared.rule.targets.excludeCollectionIds,
    );
    expect(parsed.rule.audience.tags).toEqual(prepared.rule.audience.tags);
  });

  it("keeps a percentage rule's amount out of the fields", () => {
    const prepared = prepareDraft(
      envelope({ kind: "percentage", percentage: 30, tiers: [] }),
      grounding,
      NOW,
    );
    const fields = builderFields(prepared.rule, "USD");

    expect(fields.find((field) => field.name === "percentage")?.value).toBe("30");
    expect(fields.find((field) => field.name === "amount")?.value).toBe("");
    expect(fields.filter((field) => field.name === "tierMin")).toEqual([]);
  });

  it("omits the combinable checkbox when the rule does not combine", () => {
    const prepared = prepareDraft(envelope(), grounding, NOW);
    expect(builderFields(prepared.rule, "USD").map((f) => f.name)).not.toContain(
      "combinable",
    );
  });

  it("sends the combinable checkbox the way a browser would", () => {
    const prepared = prepareDraft(envelope({ combinable: true }), grounding, NOW);
    const fields = builderFields(prepared.rule, "USD");

    expect(fields).toContainEqual({ name: "combinable", value: "on" });
    expect(
      parseRuleForm(asFormData(fields), { currencyCode: "USD" }).rule.combinable,
    ).toBe(true);
  });

  it("round-trips an amount in a three-decimal currency", () => {
    const prepared = prepareDraft(
      envelopeFor(
        "12.500 off",
        (() => {
          const read = readNamedDraft(
            answer({ kind: "amount_off", tiers: [], amount: "12.500" }),
            { ...grounding, currencyCode: "KWD" },
            NOW,
          );
          if (!read.ok) throw new Error(read.error);
          return read.value;
        })(),
        provenance,
      ),
      grounding,
      NOW,
    );

    const parsed = parseRuleForm(asFormData(builderFields(prepared.rule, "KWD")), {
      currencyCode: "KWD",
    });

    expect(parsed.rule.value).toEqual(prepared.rule.value);
  });
});

/* -------------------------------------------------------------------------- */

describe("the draft card", () => {
  it("shows every tier as its own chip", () => {
    const prepared = prepareDraft(envelope(), grounding, NOW);
    const card = draftCard(prepared.envelope, prepared.rule, "USD", t);

    expect(card.chips).toEqual([
      "describe.chip.range(10,49) · describe.chip.percentage(5)",
      "describe.chip.from(50) · describe.chip.percentage(12)",
    ]);
  });

  it("shows what Claude said it assumed, verbatim", () => {
    const prepared = prepareDraft(envelope(), grounding, NOW);
    expect(draftCard(prepared.envelope, prepared.rule, "USD", t).notes).toBe(
      "Excluded sale items as asked.",
    );
  });

  it("says when a rule is scheduled", () => {
    const prepared = prepareDraft(
      envelope({ schedule: { startsAt: "2026-10-01", endsAt: "2026-12-31" } }),
      grounding,
      NOW,
    );
    expect(draftCard(prepared.envelope, prepared.rule, "USD", t).scheduleSummary).toBe(
      "describe.scheduleBetween(2026-10-01,2026-12-31)",
    );
  });

  it("has no schedule line when there is no schedule", () => {
    const prepared = prepareDraft(envelope(), grounding, NOW);
    expect(
      draftCard(prepared.envelope, prepared.rule, "USD", t).scheduleSummary,
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

const guard = (overrides: Partial<MarginGuardResult> = {}): MarginGuardResult => ({
  status: "checked",
  sampled: false,
  detail: null,
  report: { checked: 4, costUnknown: 0, notApplicable: 0, belowCost: [] },
  ...overrides,
});

describe("the margin guard on screen", () => {
  it("reports a clean check with the number it actually checked", () => {
    const view = marginView(guard(), "en");
    expect(view).toMatchObject({ status: "checked", checked: 4, belowCostCount: 0 });
  });

  it("lists only the three worst, and still counts them all", () => {
    const belowCost = [5, 4, 3, 2, 1].map((n) => ({
      variantId: `v${n}`,
      sku: `SKU-${n}`,
      title: `Product ${n}`,
      quantity: 10,
      unitPrice: { amount: 100, currencyCode: "USD" },
      unitCost: { amount: 100 + n * 100, currencyCode: "USD" },
      shortfall: { amount: n * 100, currencyCode: "USD" },
    }));

    const view = marginView(
      guard({ report: { checked: 5, costUnknown: 0, notApplicable: 0, belowCost } }),
      "en",
    );

    expect(view?.belowCostCount).toBe(5);
    expect(view?.worst).toHaveLength(3);
    expect(view?.worst.map((one) => one.label)).toEqual(["SKU-5", "SKU-4", "SKU-3"]);
  });

  it("falls back to the product name when a variant has no SKU", () => {
    const view = marginView(
      guard({
        report: {
          checked: 1,
          costUnknown: 0,
          notApplicable: 0,
          belowCost: [
            {
              variantId: "v1",
              sku: null,
              title: "Oak table",
              quantity: 1,
              unitPrice: { amount: 100, currencyCode: "USD" },
              unitCost: { amount: 200, currencyCode: "USD" },
              shortfall: { amount: 100, currencyCode: "USD" },
            },
          ],
        },
      }),
      "en",
    );

    expect(view?.worst[0]?.label).toBe("Oak table");
  });

  it("says it could not check rather than reporting nothing found", () => {
    const view = marginView(guard({ status: "unavailable", report: null }), "en");
    expect(view).toMatchObject({ status: "unavailable", belowCostCount: 0 });
  });
});

describe("approving", () => {
  const view = (margin: ReturnType<typeof marginView>) =>
    describeView({ aiAvailable: true, sentence: "s", atRuleLimit: false, t, margin });

  it("does not ask for a tick when nothing is below cost", () => {
    expect(view(marginView(guard(), "en")).approveAnywayRequired).toBe(false);
  });

  it("does not ask for a tick when the check could not run", () => {
    // A store that has never recorded a cost would otherwise face this on every
    // save, which teaches merchants to tick it without reading it.
    expect(
      view(marginView(guard({ status: "unavailable", report: null }), "en"))
        .approveAnywayRequired,
    ).toBe(false);
  });

  it("asks for a tick when something is below cost", () => {
    const margin = marginView(
      guard({
        report: {
          checked: 1,
          costUnknown: 0,
          notApplicable: 0,
          belowCost: [
            {
              variantId: "v1",
              sku: "SKU-1",
              title: "Oak table",
              quantity: 10,
              unitPrice: { amount: 100, currencyCode: "USD" },
              unitCost: { amount: 200, currencyCode: "USD" },
              shortfall: { amount: 100, currencyCode: "USD" },
            },
          ],
        },
      }),
      "en",
    );

    expect(view(margin).approveAnywayRequired).toBe(true);
  });
});

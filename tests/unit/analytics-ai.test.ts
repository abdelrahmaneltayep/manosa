import { describe, expect, it } from "vitest";

import { readDataQuestion } from "~/lib/ai/prompts/ask-data.server";
import {
  MAX_SECTIONS,
  readReview,
  REVIEW_ACTIONS,
} from "~/lib/ai/prompts/monthly-review.server";

/**
 * The two ✦ analytics features, at the only place they can go wrong.
 *
 * Neither model computes anything: one routes a question to a chart, the other
 * writes prose around figures this app already worked out. So every test here
 * is a way a model could get past that — a chart that does not exist, a window
 * nobody sized, an action that does something, or a number typed by hand.
 */

describe("routing a question to a chart", () => {
  const route = (value: unknown) => readDataQuestion(value);

  it("reads a chart, a window and a focus", () => {
    const result = route({ chart: "buyers", range: 90, focus: "Café Aroma" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ chart: "buyers", range: 90, focus: "Café Aroma" });
    }
  });

  it("refuses a chart that does not exist", () => {
    for (const chart of ["profit", "", "../etc/passwd", 7, null]) {
      expect(route({ chart, range: 30, focus: null }).ok).toBe(false);
    }
  });

  it("falls back to the default window rather than one nobody sized", () => {
    // A model is not a validator. 3,650 days is a query against a table that
    // only reaches back 60.
    for (const range of [3650, 0, -7, "lots", null]) {
      const result = route({ chart: "revenue", range, focus: null });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.range).toBe(30);
    }
  });

  it("keeps only the windows the page actually offers", () => {
    for (const range of [7, 30, 90]) {
      const result = route({ chart: "revenue", range, focus: null });
      if (result.ok) expect(result.value.range).toBe(range);
    }
  });

  it("bounds a focus, and reads a blank one as none", () => {
    const long = route({ chart: "buyers", range: 30, focus: "x".repeat(500) });
    if (long.ok) expect(long.value.focus!.length).toBeLessThanOrEqual(80);

    for (const focus of ["", "   ", null, 42]) {
      const result = route({ chart: "buyers", range: 30, focus });
      if (result.ok) expect(result.value.focus).toBeNull();
    }
  });

  it("refuses anything that is not an object", () => {
    for (const value of ["revenue", null, [], 7]) {
      expect(route(value).ok).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("reading a monthly review", () => {
  const slots = { f1: "$12,400.00", q1: "42", n1: "Café trade price" };
  const read = readReview(slots);

  const section = (overrides: Record<string, unknown> = {}) => ({
    kind: "worked",
    headline: "{{n1}} did the heavy lifting",
    body: "It priced {{q1}} lines and brought in {{f1}}.",
    action: "open_pricing",
    // A fact line as `factLines` emits one: slot names, never figures. The
    // previous fixture wrote "rule Café trade price: 42 lines" — a shape the
    // writer cannot produce, whose bare "42" the check then had to accept, so
    // the test proved the hole rather than closing it.
    because: ["wholesale revenue: {{f1}}"],
    ...overrides,
  });

  it("reads a review whose every figure is a slot", () => {
    const result = read({ quiet: false, sections: [section()] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sections[0]?.action).toBe("open_pricing");
      expect(result.value.sections[0]?.because).toEqual(["wholesale revenue: {{f1}}"]);
    }
  });

  it("checks the audit trail too — it is the field Invariant 5 rests on", () => {
    for (const because of [
      ["we estimate revenue at $9,999,999 next month"],
      ["ربحت ١٢٣٤ ريال"],
      ["rule Café trade price: 42 lines"],
      ["wholesale revenue: {{f1}}", "and orders doubled"],
      ["it used {{f9}}"],
    ]) {
      expect(
        read({ quiet: false, sections: [section({ because })] }).ok,
        because.join(" / "),
      ).toBe(false);
    }
  });

  it("refuses a number written as a word, not only a digit", () => {
    for (const body of [
      "Your top group brought in nine hundred more than the second.",
      "Revenue doubled on last month.",
      "Café Aroma came second.",
      "المبيعات ارتفعت ثلاثة أضعاف",
    ]) {
      expect(read({ quiet: false, sections: [section({ body })] }).ok, body).toBe(false);
    }
  });

  it("never truncates through a slot", () => {
    const long = `${"x".repeat(315)} {{f1}}`;
    const result = read({ quiet: false, sections: [section({ body: long })] });

    // Slicing after the check and before the fill stored a dangling "{{" that
    // rendered at the merchant. Slicing before the check is worse: the
    // orphaned "f1" reads as an invented figure and loses the whole review.
    expect(result.ok).toBe(true);
    if (result.ok) {
      const body = result.value.sections[0]!.body;
      expect(body).not.toContain("{{");
      expect(body.length).toBeLessThanOrEqual(320);
    }
  });

  it("throws away a review that states a figure the app did not compute", () => {
    // The one thing this feature must never do: a merchant acting on an
    // invented total is acting on nothing.
    for (const body of [
      "Revenue was $18,000 this month.",
      "That is roughly 22% up on last month.",
      "سعرها ٩٠٠ ريال.",
      "Nine hundred dollars, all told.",
    ]) {
      expect(read({ quiet: false, sections: [section({ body })] }).ok).toBe(false);
    }
  });

  it("checks the headline too, not only the body", () => {
    expect(
      read({ quiet: false, sections: [section({ headline: "Up 30% on February" })] }).ok,
    ).toBe(false);
  });

  it("refuses a slot it was never given", () => {
    const result = read({
      quiet: false,
      sections: [section({ body: "It made {{f9}}." })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("f9");
  });

  it("refuses an action that is not one of ours", () => {
    for (const action of ["delete_rule", "run_sql", "open_admin", ""]) {
      expect(read({ quiet: false, sections: [section({ action })] }).ok).toBe(false);
    }
    // Every action we do offer is accepted.
    for (const action of REVIEW_ACTIONS) {
      expect(read({ quiet: false, sections: [section({ action })] }).ok).toBe(true);
    }
  });

  it("allows a section that is an observation rather than a recommendation", () => {
    expect(read({ quiet: false, sections: [section({ action: null })] }).ok).toBe(true);
  });

  it("takes a quiet month as a quiet month", () => {
    const result = read({ quiet: true, sections: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ quiet: true, sections: [] });
  });

  it("does not read an empty answer as a quiet month", () => {
    // "The model said nothing" and "the month was quiet" are different, and
    // the screen shows them differently.
    expect(read({ quiet: false, sections: [] }).ok).toBe(false);
  });

  it("takes the first few sections and no more", () => {
    const many = Array.from({ length: MAX_SECTIONS + 4 }, () => section());
    const result = read({ quiet: false, sections: many });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sections).toHaveLength(MAX_SECTIONS);
  });

  it("refuses a section missing its words", () => {
    expect(read({ quiet: false, sections: [section({ headline: "  " })] }).ok).toBe(
      false,
    );
    expect(read({ quiet: false, sections: [section({ body: "" })] }).ok).toBe(false);
  });
});

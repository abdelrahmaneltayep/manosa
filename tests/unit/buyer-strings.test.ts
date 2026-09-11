import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { editableKeys } from "~/lib/i18n/strings.server";

/**
 * Every word a buyer reads is a word the merchant may rewrite.
 *
 * `BUYER_FACING_PATHS` is a list, and a list is a registration step. 6.6
 * shipped with five whole catalogue roots in it, offering a merchant 534
 * strings of which about forty ever reached a buyer — and the cold read found
 * it the other way round too: the checkout message, which the Limits page
 * linked to as editable, was a constant in a package.
 *
 * So this reads the buyer-facing files and checks the set against them rather
 * than against an opinion. Add a surface, and it belongs in `SURFACES`.
 */

const SURFACES = [
  "app/components/forms/PublicForm.tsx",
  "app/components/orders/PublicQuote.tsx",
  "app/lib/forms/issue-message.ts",
  "app/lib/agent/buyer/turn.server.ts",
];

/** `t("some.key")` — literal keys only; a template is checked by its prefix. */
const literalKeys = (source: string) =>
  [...source.matchAll(/\bt\(\s*"([a-z][A-Za-z0-9_.]+)"/gu)].map((match) => match[1]!);

/** `` t(`forms.public.issue.${…}`) `` — the prefix has to be editable too. */
const templatePrefixes = (source: string) =>
  [...source.matchAll(/\bt\(\s*`([a-z][A-Za-z0-9_.]*)\$\{/gu)].map((match) =>
    match[1]!.replace(/\.$/u, ""),
  );

describe("the strings a buyer reads", () => {
  const editable = new Set(editableKeys());

  it("are every one of them a merchant's to rewrite", () => {
    const missing: string[] = [];

    for (const file of SURFACES) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");

      for (const key of literalKeys(source)) {
        if (!editable.has(key)) missing.push(`${file}: ${key}`);
      }
      for (const prefix of templatePrefixes(source)) {
        // A dynamic key can only be checked by its family: at least one key
        // under the prefix has to be editable, or the whole branch is not.
        const covered = [...editable].some((key) => key.startsWith(`${prefix}.`));
        if (!covered) missing.push(`${file}: ${prefix}.*`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("found something in each surface, rather than quietly matching nothing", () => {
    // A regex that stops matching is a test that stops testing. Every file
    // listed above translates something.
    for (const file of SURFACES) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(
        literalKeys(source).length + templatePrefixes(source).length,
        file,
      ).toBeGreaterThan(0);
    }
  });

  it("includes the checkout message, which no React page renders", () => {
    // It lives in a metafield the Function reads, so nothing above can see it
    // — and the Limits page links a merchant here to change it.
    expect(editable).toContain("checkout.below_minimum_subtotal");
    expect(editable).toContain("checkout.not_a_multiple");
  });
});

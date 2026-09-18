import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import en from "~/i18n/locales/en.json";

/**
 * Keys nothing renders.
 *
 * The catalogs are checked against each other — every English key exists in
 * Arabic, every plural has its categories — and both of those tests pass
 * happily on a key no screen has ever asked for. Six of them had accumulated
 * in `plans.` alone, three of which were §9 features written as copy and never
 * wired to a control. A key nobody renders is not free: it is translated,
 * reviewed, and read by the next person as evidence that a feature exists.
 *
 * So the catalog is a **total map**: every key is either rendered by something
 * in `app/`, or named below with the reason it is still here. A new key that is
 * neither fails this test on the commit that adds it, rather than surfacing in
 * a cold read eighteen tasks later.
 */

type Json = { [key: string]: string | Json };

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(node: Json, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.push(path);
    else out.push(...flatten(value, path));
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * What the app could be asking for.
 *
 * Deliberately generous in the direction that costs nothing: any string
 * literal that looks like a key counts as a use, and a template literal
 * (`` t(`pricing.issue.${code}`) ``) marks its whole prefix as used. Over-
 * counting leaves a dead key alive, which this test then misses; under-counting
 * would fail the build over copy that ships. Only one of those two is a
 * disaster, so the scan errs towards the other.
 */
function keysTheAppMightRender(): { literals: Set<string>; prefixes: string[] } {
  const literals = new Set<string>();
  const prefixes = new Set<string>();

  for (const file of sourceFiles("app")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'`]([a-zA-Z][\w.-]*?)["'`]/g)) {
      literals.add(match[1]!);
    }
    for (const match of source.matchAll(/`([a-zA-Z][\w.-]*?)\$\{/g)) {
      prefixes.add(match[1]!);
    }
  }

  return { literals, prefixes: [...prefixes] };
}

/**
 * Copy written before the control it belongs to.
 *
 * Each of these is a real gap, not dead weight: deleting the words would hide
 * the missing thing rather than fix it. The reason is written down so the next
 * person can tell "not built yet" from "nobody noticed".
 */
const WRITTEN_AHEAD: Record<string, string> = {
  // The rule builder renders one row per tier that already exists. There is no
  // control to add or remove one, so a merchant cannot write a second break.
  "pricing.builder.addTier": "the tier editor has no add control",
  "pricing.builder.removeTier": "the tier editor has no remove control",
  // CLAUDE.md: "Every form guards unsaved changes." The builder does not.
  "pricing.builder.unsavedChanges": "the builder has no unsaved-changes guard",
  "pricing.builder.leaveHeading": "the builder has no unsaved-changes guard",
  "pricing.builder.leaveBody": "the builder has no unsaved-changes guard",
  "pricing.builder.leaveConfirm": "the builder has no unsaved-changes guard",
  "pricing.builder.leaveCancel": "the builder has no unsaved-changes guard",
  // Targets are typed as ids; there is no resource picker behind them yet.
  "pricing.builder.browse": "no resource picker",
  "pricing.builder.exclusionsHeading": "exclusions are edited as ids, unlabelled",
  "pricing.builder.saveAndActivate": "the builder saves, then status is a field",
  "pricing.builder.previewProduct": "the preview has no product switcher",
  "pricing.builder.previewDesktop": "the preview has no viewport switcher",
  "pricing.builder.previewMobile": "the preview has no viewport switcher",
  // The list is ordered by priority and filtered by tab; neither sorting nor
  // the two hover hints exist.
  "pricing.list.sortBy": "the list has no sort control",
  "pricing.list.unusedHint": "no hint beside the unused badge",
  "pricing.list.missingTargetsHint": "no hint beside the missing-targets badge",
  // The conflict banner offers overwrite or keep-theirs. A side-by-side of the
  // two versions was written and never built.
  "pricing.conflict.theirs": "no side-by-side diff of a save conflict",
  "pricing.conflict.yours": "no side-by-side diff of a save conflict",
  // The CSV page uses a plain file input and a link, not a labelled dropzone
  // or an export section of its own.
  "csv.exportHeading": "export is a link, not a section",
  "csv.dropzoneLabel": "the upload is a file input, not a dropzone",
  // Remix's root error boundary renders its own copy. These were written for a
  // boundary that reads the catalogue, which would need the i18n provider to
  // survive the error that tripped it.
  "error.notFound.heading": "the error boundary does not read the catalogue",
  "error.notFound.body": "the error boundary does not read the catalogue",
  "error.generic.heading": "the error boundary does not read the catalogue",
  "error.generic.body": "the error boundary does not read the catalogue",
};

describe("the English catalogue is a total map", () => {
  const { literals, prefixes } = keysTheAppMightRender();
  const keys = [
    ...new Set(flatten(en as Json).map((key) => key.replace(PLURAL_SUFFIX, ""))),
  ];

  const rendered = (key: string) =>
    literals.has(key) || prefixes.some((prefix) => key.startsWith(prefix));

  it("has no key that nothing renders and nothing explains", () => {
    const unexplained = keys.filter((key) => !rendered(key) && !WRITTEN_AHEAD[key]);
    expect(unexplained).toEqual([]);
  });

  it("keeps the written-ahead list honest", () => {
    // A control that gets built makes its entry wrong in the safe direction —
    // the key is rendered now — and this is what says so, rather than letting
    // the list grow into a second catalogue nobody reads.
    const nowRendered = Object.keys(WRITTEN_AHEAD).filter(rendered);
    expect(nowRendered).toEqual([]);
  });

  it("only names keys that exist", () => {
    const known = new Set(keys);
    expect(Object.keys(WRITTEN_AHEAD).filter((key) => !known.has(key))).toEqual([]);
  });

  it("gives every exception a written reason", () => {
    const blank = Object.entries(WRITTEN_AHEAD)
      .filter(([, reason]) => reason.trim() === "")
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });
});

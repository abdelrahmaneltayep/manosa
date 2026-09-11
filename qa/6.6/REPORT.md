# QA — 6.6 Translations

Date: 2026-09-11 · Gate: **pass** (own seven steps) · Cold read: see `COLD-READ.md`

## 1. Test plan

Spec: `feature-checklist.md` §8 — *"Translations: table of strings, '✦ Fill
missing with AI' per language, human-review flag per string, export/import."*
`pages-features.md` §8 · `docs/adr/0028-storefront-strings.md`.

The one question everything else serves: **does a word a merchant types reach
the buyer?** A table that saves a row nothing renders is the shape this repo
keeps finding (the 6.4 write-only settings, the 6.5 ungated POST), so the first
test written was the round trip through `getFixedT`, not the table.

Happy paths

- Edit a string → it renders in that shop's pages, in that language.
- ✦ suggest wording for strings the merchant has not written → arrives marked.
- Accept a suggestion → the mark goes, the words do not change.
- Export a language → only the merchant's own strings.
- Import that same file back → the wording returns.

States

| State | Where |
| --- | --- |
| Table, three kinds of row (shipped / yours / suggested) | `01-translations` |
| Validation error, beside the field that caused it | `02-translations-error` |
| Empty because filters, not because nothing exists | `03-translations-filtered-empty` |
| ✦ unavailable — permission / plan / no key (three distinct copies) | `04-translations-no-key` |
| ✦ wrote some | `05-translations-filled` |
| ✦ call failed | `06-translations-failed` |
| Arabic, RTL | `07-translations-arabic` |
| Import did something, refusals named | `08-translations-imported` |
| Import refused whole, with what to send instead | `09-translations-import-refused` |
| Running (`fill.running`) | asserted; not captured — same render as ✦ disabled |

Abuse cases invented for this task

1. A file for another language imported into this one.
2. A file with `__proto__` and `constructor` as keys.
3. A file with more strings than the app has, and a file that is not JSON.
4. Two shops with the same key: neither may read or overwrite the other's.
5. A translation that dropped its `{{days}}` — from the model, and from a file.

## 2. Automated

- `tests/integration/translations.test.ts` — 24 tests: the editable set, a
  merchant's wording reaching the buyer, tenancy, clearing, placeholders, the
  audit's silence about words, ✦ suggestion and its refusals, import in full,
  export.
- `tests/unit/translations-page-states.test.tsx` — 12, every state above.
- `tests/unit/capture-guard.test.ts` — 5, new; see §5.
- `tests/e2e/translations-forms.spec.ts` — 3, in Chromium, over the capture.
- `tests/integration/jobs.test.ts` — one added: the uninstall purge reaches
  `StorefrontString`.
- Whole suite: **2145 passing across 115 files, 0 failing, 0 skipped.** `lint`, `typecheck`,
  `format:check`, `build` all clean.

Each new test was watched failing first, by breaking the thing it covers. The
purge test was run against a `deleteMany` pointed at another shop and failed as
it should.

## 3. The states, walked

`npm run qa:capture` → nine HTML captures, nine PNGs, **no two identical**
(`md5sum | uniq -d` empty; `expectDistinct` also enforces it in the test run).

What this proves: which content and which states render, and that no raw i18n
key reached the page. What it does not prove: what a merchant sees. Polaris
`s-*` elements never upgrade here — no CDN egress — so the styling is a
stand-in and every capture says so at the top. **This is not a visual pass.**

One thing the browser pass did surface, and it is worth writing down: in the
capture an `s-text-area` is an unknown element, so it is not a form control and
does not appear in `FormData`. The e2e spec therefore checks the hidden fields
through the real parser and the wording field as markup. What a merchant's
typing actually posts is still unverified in this environment.

## 4. Boundary

- `listStrings`, `saveString`, `acceptString`, `fillMissing`, `importStrings`,
  `exportStrings`, `unwrittenIn` all begin with `shopScope.require(...)`.
- Alpha writes `forms.submit`; Beta reads the shipped string, lists every row
  with `value: null`, and an import into Alpha leaves Beta's row untouched.
  Reaching across reads as absent, never as a leak.
- `acceptString` looks up by key and locale inside the scope, so another
  shop's suggestion cannot be accepted by naming it.

## 5. Invariants

1. **Pricing engine** — untouched; this feature holds no numbers.
2. **Shop scope** — §4.
3. **AI drafts, a person approves** — `fillMissing` calls `requireAi("draft")`
   before anything else (the 6.5 P0 lesson: the test written first was the call
   with the permission off). Everything it writes is `aiFilled` **and**
   `needsReview`; `update: {}` means it can only ever fill a gap. Timeout,
   retry and the manual fallback come from `askForJson`; with no key the page
   says so and the table still works.
4. **Nothing claims to have happened that did not** — an import names every
   string it refused and why; a file refused whole says which file to send
   instead; "no file" and "too large" are their own messages rather than
   borrowing another's. The audit records the key, the language and counts —
   never the words. `MAX_IMPORT_BYTES` lives in a plain module so the page can
   show the number without pulling Prisma into the client bundle; `build/client`
   greps clean for `PrismaClient` and `ANTHROPIC`.
5. **Deciding shows its working** — every row says who wrote it (shipped /
   yours / Claude suggested), and the wording field names the exact tags a
   translation has to keep, braces and all.

Console: no new noise. No unhandled rejections in the Playwright run.

## 6. Bugs found and fixed in this pass

1. **The ✦ fill would have been inert.** Both catalogues ship complete, so
   "fill what is missing" had nothing to do on any store — the fourth instance
   of a control that cannot act (`taxExemptNeedsApproval`, the auto-approve
   toggle, the API keys page). Repointed at *"suggest wording in your voice"*
   over the strings a merchant has not written, fed by the 6.5 brand-voice
   samples that no prompt had yet read.
2. **The tags help said `Keep days exactly as written`.** A merchant retyping
   that produces `days`, not `{{days}}`, and the buyer reads a sentence with a
   hole in it. The list is now formatted with its braces.
3. **`StorefrontString` was not named in the uninstall purge.** Settings
   promises everything stored about a shop goes within 48 hours; a table with
   no relation is in no cascade. Named, with a test.
4. **A wrong error for an empty upload and an oversized one.** Both fell
   through to copy about the file's *shape* and its *number of strings*. Each
   has its own message now, and the size limit is this page's own (2 MB) rather
   than the CSV importer's 10 MB borrowed from another feature.
5. **The capture guard had to be taught about this one page** — see below.

## 7. The capture guard

Every capture in this repo is checked for a raw i18n key rendered as text,
because i18next falls back to the key and `forms.submit` mid-page is invisible
in a screenshot. This page shows a merchant those keys on purpose.

Switching the guard off for the page was the tempting fix and the wrong one:
the Translations page is exactly where a genuine fallback would be hardest to
spot. The exemption is per element — `data-string-key` on the element that
prints the key — so everything else on the page is still checked, and
`tests/unit/capture-guard.test.ts` holds it to that with a case that puts a
real leak next to an exempt element and expects a failure.

## 8. Not covered here

- No merchant has seen this page rendered by Polaris (environment).
- No string has been rewritten on a live storefront (no dev store).
- ✦ has never been answered by Anthropic (no key). The prompt, the placeholder
  check on the reply and the three failure states are driven through an
  injected client.

# QA report — 1.4 · CSV import and export


**Verdict: pass with open items.** Templates, upload, dry run, problem CSV,
import, undo and export all work and are covered. `.xlsx` is deliberately not
accepted (§7).

### 1. Test plan

_Happy paths_

- Download a template, fill it in, import it; export, edit, import back.
- Rows sharing a name become one rule with several quantity breaks.
- Import creates rules and publishes live ones to checkout.
- Undo removes exactly what the import created.

_States (checklist §2 CSV import)_

- Choose a file; file over 10 MB; over 50,000 rows; unreadable; unrecognised
  columns; dry run with counts; dry run with nothing importable; dry run that
  would be too big for checkout; imported with undo; undone; undo expired;
  Arabic.

_Three invented abuse cases_

1. **Malformed input** — a file that ends inside a quote, a BOM, CRLF, ragged
   rows, a stray quote mid-field, blank lines, an unknown rule type, a
   non-numeric priority, unparseable money, a bad date, and a 150% discount.
2. **Concurrency** — undo clicked twice, and undo after the window closed.
3. **Wrong shop/tenant** — undoing another shop's import.

### 2. Automated tests

`npm test` — **451 passed** (29 files), up from 383. This task adds 68:

| Suite                                      | Cases | Covers                                                                                                                                                                                                  |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/csv-parse.test.ts`             | 17    | Quotes, embedded commas and newlines, doubled quotes, CRLF, BOM, ragged rows, blank lines, trailing newline, a stray quote, empty file, unclosed quote, and a write/read round trip                     |
| `tests/unit/csv-plan.test.ts`              | 21    | Template detection, both templates, merchant spellings, SKU resolution, unknown SKUs listed, every issue code, zero-as-warning, duplicate names, last-wins, tier overlap, good rows surviving a bad one |
| `tests/integration/csv-import.test.ts`     | 19    | Import and publish, draft imports not published, batch quota check, audit entry, undo semantics and expiry, tenant isolation, the size guard, exact-match SKU lookup, export round trips                |
| `tests/unit/pricing-pages-states.test.tsx` | +11   | The eleven CSV states above                                                                                                                                                                             |

Lint, typecheck and build clean.

### 3. State walkthrough

Eleven states captured to `qa/1.4/`. Same caveat as before: these verify which
content and which states render, not how they look.

### 4. Cross-tenant check

Undoing another shop's import raises 404 and leaves its rules intact. Every
import read and write goes through the scoped client, and `RuleImport` and
`RuleImportDraft` both carry `shop`, so the scope guard covers them without a
registration step.

### 5. The three musts

| Rule                                           | Status at 1.4                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | Held. Imported rows are validated by `validateRule` and stored in the engine's wire shape; nothing computes a price here. |
| No AI mutation without an approval record      | Unchanged. The CSV whisperer (AI column mapping) is 4.3; this task is the manual path it will build on.                   |
| No unhandled promise rejections in the e2e run | Unchanged and clean.                                                                                                      |

### 6. Bugs found and fixed

1. **The confirm step could not have worked.** A browser does not resubmit a
   file input, so "Import 214 rules" would have posted without the file and
   returned 400. Caught by reasoning through the flow rather than by a test —
   the tests exercised the planner and the importer, not the round trip between
   them. Fixed by holding the upload in `RuleImportDraft` so confirm imports
   exactly the bytes that were checked.

2. **The downloaded template did not import.** Its example row referenced SKU
   `ABC-1`, which exists in no merchant's store, so a merchant downloading the
   template and importing it unchanged would meet an error on their first try.
   The test asserting the template round-trips caught it; the template was wrong,
   not the test. Both examples now target everything, and the SKU column
   explains itself.

3. **English plurals, a third time.** Six more count-bearing keys written bare
   instead of `_one`. Fixed, and the rule is now written down in the README next
   to the i18n section, since catching it three times means the guard works but
   the authoring habit did not.

A fourth was cosmetic and caught by reading a capture: the problem table's
section heading repeated its own column header ("Problem" above "Problem").

### 7. Open items

- **`.xlsx` is not accepted.** Checklist §2 puts it in the dropzone, but "upload
  any messy price sheet, even a supplier's Excel" is the CSV whisperer (4.3),
  where AI column mapping is what makes an arbitrary sheet meaningful. Accepting
  `.xlsx` here and then failing to read it would be worse than saying CSV.
- **Per-variant price lists do not fit.** A price list of any size becomes one
  rule per variant, and the published ruleset hits Shopify's metafield limit at
  roughly two hundred. The dry run now refuses with the numbers rather than
  letting an import half-land, but the real fix is a `price_list` rule kind
  holding many variant→price entries in one rule. That is an engine change and
  needs its own task — it also blocks demo persona 2 ("individual variant
  pricing") from working at any realistic size.
- **Import always creates, never updates.** Re-importing an edited export makes
  a second copy rather than updating the original. Matching on name would be the
  obvious next step, but it changes what undo has to restore, so it is a
  deliberate follow-up rather than a half-built merge.
- **Drafts are never pruned.** `RuleImportDraft` rows from abandoned uploads
  accumulate; deletion on use is implemented, expiry sweeping belongs with the
  retention jobs in 7.2.
- **Unchanged and still blocking Phase 1:** the dev-store run from 1.2.

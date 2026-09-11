# 28. The strings a buyer reads belong to the merchant

Date: 2026-09-11 · Status: accepted

## Context

Checklist §8 asks for **"Translations: table of strings, '✦ Fill missing with
AI' per language, human-review flag per string, export/import."**

Until now every word this app puts in front of a buyer was Mannon's. The
registration form, the quote a buyer accepts, the approval and rejection
emails, the message at checkout when an order misses a minimum and the Buyer
Agent widget were all `t("forms.submit")` and nothing else — five hundred and
thirty-odd strings a merchant could not touch. 6.4's Limits page said, in as
many words, that the checkout message "is not editable yet", which is a promise
with a due date on it.

Two sub-decisions were not obvious.

**Which strings.** The theme blocks' own headings and intros are
`block.settings` in the liquid — already editable in the theme editor, where a
merchant goes to edit their theme. Taking them over would give one sentence two
places to edit, and the one a merchant found first would be the wrong one.

**What "fill missing" means.** Both catalogues this app ships are complete, in
both languages. A button that translates the strings a language has no
translation for would therefore have had nothing to do on any store, ever —
the inert control this repo has now caught three times (`taxExemptNeedsApproval`
in 6.4, the auto-approve toggle in 6.5, and the API keys page it declined to
build). What a merchant actually lacks is not a translation but their own
voice: a trade supplier with a house style has five hundred strings that sound
like somebody else's shop.

## Decision

**The editable set is derived from the catalogue, not listed.** Five
buyer-facing roots — `agent`, `approval`, `forms`, `limit`, `quotes` — are
walked at call time, so a string added to any of them is editable the day it
ships. A hand-kept list is a registration step, and this repo has forgotten
three of those (`CATALOG_ROOTS`, `qa:capture`'s file list, the audit action
picker). Forgetting one here means telling a merchant a string is not theirs
to change when it is the only one a buyer reads.

**Overrides are applied where the i18next instance is built**, in
`createI18n(locale, overrides)`, not at each call site. There is exactly one
place an instance is made per request, so there is no surface that can
translate without a merchant's wording — which is the only thing that makes
the table worth having. A table that stores a row nothing renders is the shape
this repo keeps finding.

Dotted keys go in one at a time through `addResource`, because i18next reads a
dot as a path: a flat `{"forms.submit": …}` bundle would create a literal key
with dots in it and silently never match.

**The placeholder set is the load-bearing check.** `{{days}}` in the shipped
string and nothing in the merchant's means a buyer reads "your quote expires
in days". i18next does not complain — it has nothing to interpolate — so the
merchant finds out when somebody tells them. Every write path checks it: the
single save, the ✦ suggestion (a reply whose placeholders differ is dropped
rather than shown), and the import (named as refused rather than applied).

**✦ suggests wording in the merchant's voice, for strings they have not
written**, fed by the brand-voice samples 6.5 stored and no prompt read.
Everything it writes is marked twice — `aiFilled` and `needsReview` — and
never overwrites a string a merchant wrote. Invariant 3 in its plainest form.

**Import refuses out loud.** A file comes back from a spreadsheet, a
translator and an email client, and any of those can eat a tag. Every string
the file asked for and this app refused is named with its reason; a file whose
locale disagrees with the page is refused whole, because Arabic imported as
English would reach the English storefront one string at a time with nothing
to say it had happened.

## Consequences

- One more table (`StorefrontString`) and one more row in the uninstall purge.
  Settings promises everything stored about a shop goes within 48 hours, and a
  table nobody names in `purge-shop-pii.server.ts` outlives that promise
  quietly. Named, and tested.
- `getFixedT` now does a query per request when a shop scope exists. It is one
  indexed read on `(shop, locale)` returning at most a few hundred short rows,
  and it is the price of the wording reaching the buyer at all.
- The audit trail records the key and the language, never the words. An audit
  summary is read in a list; the words are on the page one click away.
- The capture guard, which fails any page rendering a raw catalog key as text,
  needed a way to allow this one page — whose job is to show a merchant those
  keys. It is per element (`data-string-key`), not per page, so a real leaked
  fallback elsewhere on the Translations page still fails. `tests/unit/
  capture-guard.test.ts` holds it to that.

## Rejected

- **A hand-kept list of editable keys.** See above: three forgotten
  registration steps already.
- **Editing the theme blocks' strings here too.** Two places to edit one
  sentence.
- **Making the merchant the owner of all 534 strings on export.** The export
  carries only what they changed, so the rest keep improving when Mannon
  improves them.
- **Letting a blank cell in an imported file clear a string.** Clearing is a
  deliberate act on the page; a spreadsheet with an empty row should not blank
  a buyer-facing sentence.

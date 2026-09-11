# QA — 6.4 Settings, part one

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-11 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

> **Status: gate clean. The independent cold read has not run yet.**
>
> The headline find is not in the new code: **`pausedAt` had existed since 0.1
> and stopped nothing that mattered.** It was read in exactly one place, so
> "pause the app" stopped the storefront blocks and left the discount Function
> pricing every checkout. See §7 and `docs/adr/0026`.

## 1. Scope

Checklist §8's merchant-facing half: the section shell with a save bar per
card, wholesale tags, storefront display, discount combinations with the
"affects 3 active rules" warning, tax, orders and quotes, notifications with
sender-domain verification, and the danger zone.

Also in scope by necessity: **six `Shop` columns that no code path could
write.** `requireVatForTaxExempt`, `wholesaleOrderTag`, `quoteExpiryDays`,
`quoteReminderDays` and `pausedAt` were defaults a merchant could not change,
and `wholesaleTag` was only ever set by the setup wizard.

Not in it: API keys, translations with the ✦ fill, and agent controls — 6.5,
per the split recorded in `DECISIONS.md`.

## 2. Test plan

Spec re-read: `feature-checklist.md` §8, `pages-features.md` §8, `CLAUDE.md` →
Invariants 2, 4 and 5 and the Shopify appendix's form and error conventions.

**States:**

| Condition | What happens |
| --- | --- |
| Every section, populated | each change's blast radius beside it |
| No rule combines | "no active rule is set to combine", not "affects 0" |
| Compare-at off, tax inclusive | preview drops the struck price, note changes |
| A tag with a comma | error beside the field, **nothing** written |
| A reminder after expiry | error beside the field it belongs to |
| Saved | confirmation on that section, not the page |
| No sender at all | says mail cannot be sent, and what happened to it |
| Sender set, never checked | "Not checked yet" — not "unverified" |
| Checked and missing | the provider's own words, and the fallback |
| Verified | the fallback claim stops |
| No provider configured | Verify disabled, with the reason beside it |
| Pause confirm | what stops, and what is kept |
| Paused | banner at the top of the page, not only in the zone |
| Arabic | RTL, whole page translated |

**Three abuse cases I invented:**

1. **A POST that names the danger zone as a section.** Can a plain form post
   pause a shop without going through the confirm?
2. **A rule saved during a pause.** Does the next publish quietly put a live
   ruleset back?
3. **Wrong-tenant everything.** β's rules, buyers and tag read from α's
   Settings; α pausing while β keeps pricing.

## 3. Automated

New:

- `tests/unit/settings.test.ts` — 2 (which sections a form body may name)
- `tests/unit/settings-page-states.test.tsx` — 15 (every state above, and the
  captures)
- `tests/integration/settings.test.ts` — 14 (saving, pausing, the view, both
  tenants)

**Whole suite: 2,069 unit + integration across 111 files, green.**
**Playwright: 399 passed.** `npm run lint`, `npx tsc --noEmit`, `npm run
build`, `npm run format:check` clean.

### Abuse cases, results

1. **`section=danger` through `saveSettings`.** `isSection` refuses it, and the
   action routes the danger zone through its own branch with a confirm and a
   redirect. Pinned by *"refuses anything else, including the danger zone"*.
2. **A rule saved while paused.** Covered by *"cannot be un-paused by saving a
   rule while paused"*: whatever republishes reads `activeEngineRules`, which
   returns nothing while paused, so there is no path that puts a live ruleset
   back except resuming.
3. **Wrong tenant.** Covered three ways — see §5.

**Watched fail before passing.** The three pause tests were re-run with the
`pausedAt` check removed from `activeEngineRules`: all three went red
(`expected [ …2 rules ] to have a length of +0`). A pause test that passes
with the pause taken out is a test that proves nothing, and this session has
already shipped three of those.

## 4. States walked

12 captures in `qa/6.4/`, rendered from the props the view model builds and
screenshotted by Playwright. All 12 are distinct renders (`expectDistinct`
enforces it, and the PNGs were re-checked by hash).

**What this proves:** which content and which states render, and that no raw
i18n key reached the page. **What it does not:** what a merchant sees — no
Polaris in this environment, and every capture says so in its own banner.

### Two things every capture in this repo had been hiding

Looking at `01-settings.png` rather than the assertions found that the capture
stand-in had **no CSS rule for `details` or for `checked`**. So:

- every field's help text — which on this page carries almost all of the
  "what this change affects" copy — rendered as nothing, in **every capture
  ever taken**; and
- a ticked checkbox was indistinguishable from an unticked one, which makes a
  capture of a settings page worth very little.

Both now render. This is the third time this exact shape has appeared (after
`[error]` last round): **the stand-in only shows what it has a rule for, and
an attribute with no rule reads as absent however many assertions pass on
it.** It is now a standing note in `PROGRESS.md`.

## 5. Boundary

Two shops, α and β, with the scope helper:

| Attempt | Result |
| --- | --- |
| α saves its wholesale tag | β's tag unchanged |
| α reads Settings while β has 1 combinable rule | α sees `0` |
| α pauses | β still prices its own rule |
| α's buyer count with a renamed tag | follows α's *current* tag, not the default |

Every function in `app/lib/settings/` calls `shopScope.require(...)`, and the
danger-zone action is `withAdmin`-wrapped like every other. No
`withoutShopScope` anywhere near this code.

## 6. Invariants

1. **Pricing engine.** Nothing here computes a price. The display preview is
   two figures formatted by `formatCurrency` from `money()` and labelled as a
   worked example, and pausing goes *through* `activeEngineRules` rather than
   around it.
2. **Shop scope.** §5.
3. **AI drafts; a person approves.** No AI on this page. (The agent permission
   toggles are 6.5.)
4. **Nothing claims to have happened that did not.** The sender has four
   states and "never checked" is not reported as "unverified"; changing the
   address clears the tick, because a domain verified for one address is not
   proof of another; with no provider, Verify is disabled with the reason
   beside it rather than being a button that checks nothing; and pause now
   actually stops the rules. No secrets in the client bundle (`build/client`
   scanned). No PII in logs — the audit entries store the section and the
   field *names* that changed, never the values.
5. **Deciding shows its working.** Every risky change carries its blast radius
   next to it, and the discount-combination count links to the rules it
   counted rather than asking the merchant to trust a number.

Boolean attributes on `s-*` all go through `whenChecked` / `whenDisabled`.
Count-bearing keys have `_one`/`_other` in English and all six categories in
Arabic and are called with `count` (`tests/unit/i18n-catalogs.test.ts` and the
capture guard both check it).

## 7. Bugs found, and fixed

### P0 — "Pause app" did not stop wholesale pricing

`Shop.pausedAt` has existed since 0.1. It was read in exactly one place —
`app/lib/storefront/proxy.server.ts:158`, which returns 503 — so pausing
stopped the theme blocks and the widget and left **the discount Function
pricing every checkout unchanged**, because Shopify evaluates the published
metafield without asking this app anything. Quotes, PO-to-order and quick
order kept applying wholesale prices too.

A merchant pauses because something is wrong and they want it to stop *now*.
This is the one control that has to be true the moment it is pressed.

Fixed in two places, because there are two kinds of consumer:
`activeEngineRules()` — the single read behind every pricing path in our own
code — returns nothing while paused, and pausing also publishes an **empty**
ruleset, which is the only way to reach the Function. `docs/adr/0026` has the
reasoning and the three alternatives rejected.

### P2 — with no provider *and* no sender, the page explained nothing

The "no sender set" branch returned before the Verify button, so a shop with
neither saw no button and no reason for its absence — and was left to work out
for themselves why nothing sends. The reason now renders in that branch too.

### P2 — help text and checkbox state were invisible in every capture

§4. Not a product bug; a capture-honesty one, and the third of its kind.

## 8. What this run does not cover

- **Sender-domain verification against a real provider.** There is no provider
  key in this environment, so **no DNS record has ever actually been checked.**
  The four states, the records table and the fallback copy are all built and
  driven; the Verify action returns 501 rather than pretending. This is stop
  condition #4 — the unblocker is a provider key.
- The embedded admin. No Polaris, no App Bridge, no iframe here.
- A real dev store, and Built for Shopify budgets at p75.
- The independent cold read, which has not run yet.

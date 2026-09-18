# QA — the twelve pricing P1s from `qa/1.1-1.2/COLD-READ.md`

**Date:** 2026-09-18
**Scope:** P1-5 through P1-16, plus P2-17, which fell out of P1-7.
**Verdict:** ten fixed, one built as a feature, one recorded as a deliberate
gap with the blocker named. All eighteen of the reviewer's probes now pass.

## The money one first

### P1-5 · Percentage rules rounded the wrong way, always against the merchant

`money.ts` opens with *"No price arithmetic anywhere in this package touches a
floating-point value."* The cascade did: a percentage became
`(100 - percentage) / 100` and the running price was multiplied by it in binary
floating point. Every value that should land exactly on a half-cent tie landed
just below one, and `half_up` rounded it down.

**$10.75 with 6% off.** Exactly `1075 × 94 / 100 = 1010.5`, half-up **1011**.
The engine returned **1010**. A cent per unit, in the buyer's favour, on every
line, for ever — 12,096 wrong answers across whole-number percentages against
prices to $2,000.00, and 1,540 more across two-decimal percentages. Every one
low.

**Fixed** by making the sentence true. The running price is a `Fraction` —
integer numerator over integer denominator, reduced to lowest terms after each
step — and a percentage is an exact ratio (`6%` is `9400/10000`, which is
representable; `0.94` is not). `roundFraction` compares `2 × remainder` against
the denominator, so a tie is an integer comparison rather than a comparison
against 0.5 in floating point.

Precision is given up in exactly one place, and it takes **four** stacked
percentage rules on one line against a price sharing no factor with 10,000 to
reach it. `rounding.test.ts` pins that it survives three.

Verified against the reviewer's two brute-force sweeps: 39.8M cases, zero
mismatches, where there were 13,636 before.

## The rest

### P1-6 · "Why this price?" was not the checkout answer

`explainFor` built a context with `groupIds: []`, `companyId: null`,
`collectionIds: []`, `productId = variantId` and a `cartSubtotal` of the
**unit** price — so four of six audience modes, two of four targeting modes and
every cart-value rule above quantity one answered wrongly, while the route above
it said *"this answer is the checkout answer"*.

**Fixed:** the input is the whole context now, and the route resolves it from
the same places checkout reads — the buyer from the mirrored `Customer` row
(a new email field), the product and its collections from the
`$app:mannon.collections` metafield the Function reads (a new `variantById`
query). `cartSubtotal` is the line, not the unit.

And where it genuinely cannot answer, it says so rather than guessing: a
buyer's Shopify B2B company arrives on the cart at checkout and is mirrored
nowhere, so company-targeted rules are named as unanswerable instead of being
reported `audience_mismatch`. The screen names the buyer, the collection count,
and what it could not know.

### P1-7 · Schedules were a day early, and the shop's timezone was never used

The builder's fields are `s-date-field` — day granularity — and
`new Date("2026-07-01")` is UTC midnight. So a rule set to end 1 July was dead
for the whole of the day the merchant named, and in a US-Pacific store a rule
starting "1 July" went live at **18:00 on 30 June, store time**. The shop's
`ianaTimezone` was populated and respected by every analytics surface, and by
nothing here.

**Fixed:** `dayStart`/`dayEnd` next to `localDay`, using the binary search
`monthStart` already proved (a quarter-hour grid, because Kathmandu and Chatham
are not on the hour) — `monthStart` now delegates to it. Both builder routes
pass the shop's zone; the field round-trips through `localDay`, so re-saving a
rule no longer moves the date.

**P2-17 fell out of the same change:** an unreadable date returned `null` and
added no issue, so a merchant who typed `31/12/2026` saved a rule with no end
date at all and was told nothing. It reports `date_unreadable` now.

### P1-8 · A later combinable rule overwrote a contract price — upward

The cascade comment promises *"a negotiated contract price is a promise"*, and
`set` was unconditional: a combinable contract price of $80.00 followed by a
combinable cart-value tier of $90.00 resolved to **$90.00**, with the trace
reporting both as applied.

**Fixed:** a `set` that would raise the price above the one already reached
stands aside with a new reason, `would_raise_price`. Only once something has
applied — the first rule is still free to set whatever the merchant asked for.

The reviewer's probe expected `applied: ["contract", "cart-tier"]` — both
applied, the higher clamped. The engine does better: the tier does not apply
and the trace says why. Reporting a rule as applied when it changed nothing is
its own kind of lie.

### P1-9 · A price-raising rule was honoured everywhere except checkout

A `fixed_price` of $120.00 on a $100.00 item: the preview said "now $120.00",
the quote locked it, the agent quoted it, and checkout charged $100.00 —
Shopify's discount API only takes money off a line.

**Fixed, but not by changing the preview.** Showing checkout's $100.00 would be
wrong for the other half of the product: a quote and a draft order carry
`originalUnitPriceWithCurrency` and really do charge $120.00. So the preview
shows what the engine resolved and the builder carries a warning beside it
naming exactly which surface will not honour it and why. The screen as a whole
is true; before, nothing anywhere said it.

### P1-10 · Market scoping — **recorded, not built**

The one thing here that is not a fix. `MarketScope` is in the engine, three
golden vectors exercise it, and `pages-features.md:53` promises it — but the
checkout Function cannot evaluate one: it knows the buyer's **country**, not
which Shopify Market that maps to (`Localization.market` is deprecated; the
mapping is per-shop). Building the form first would ship a field that creates
rules the admin shows applying and checkout silently drops.

So `parseMarkets` now refuses a scope posted by hand for the same reason the
builder has no field for it, `tests/unit/market-scoping.test.ts` fails the
moment any writer starts emitting one, and `DECISIONS.md` names the unblocker:
publish the country-to-market map to the Function first.

### P1-11 · Multi-currency amounts could not be entered — **built**

`CurrencyAmount.overrides` had been in the model since 1.1 with every
production writer setting `{}`. In a store selling in more than one currency the
engine skipped every `fixed_price` and `amount_off` rule outside the home
currency with `no_price_in_currency` while percentage rules carried on — so a
buyer checking out in EUR lost exactly their **negotiated contract prices** and
kept the discounts.

**Built:** repeatable currency/amount rows on the two absolute rule kinds.
Typed, never converted — the engine refuses to invent an exchange rate and so
does the form, because a figure the merchant did not type is a price nothing
else in the system agrees with. Each amount parses in its own currency's minor
units, so ¥1,200 is 1200 and not 120,000. A bad code and a second price in the
home currency are both refused with their own messages.

### P1-12 · Two banners wired to constants

`unreadableCount: 0`, hardcoded, while `republish` threw the real list into
`console.error` — so a rule that could not be decoded was absent from checkout
and displayed as **Active**, and the banner written to say so could never
render. Now read from the engine's own report.

`cachedMinutesAgo` stays null, and that is the honest answer rather than an
oversight: this list comes from our own database, which either answered or
threw. There is no cache to be stale.

### P1-13 · The backfill only published buyers with one particular tag

`isWholesale` was `groupId !== null || tags include record.wholesaleTag`. The
builder defaults `audienceMode` to `"tags"` and encourages a rule like
`tags: ["gold"]` — and a buyer tagged `gold` was not "wholesale" by that test,
so their `$app:mannon.buyer` metafield was never written at install. Their admin
price was right and checkout charged them retail until somebody edited them in
Shopify.

**Fixed:** the criterion is the configured tag **plus every tag any active rule
targets**, matched case-insensitively as the engine does.

### P1-14 · A format bump would charge every buyer retail

`deserializeRuleset` compared `v` against a single constant. The app and the
Function ship independently, so the day anybody bumped it the deployed Function
returned zero rules — with nothing but a `console.error` inside a WASM sandbox.

**Fixed:** `SUPPORTED_RULESET_VERSIONS` is what the Function can *read*, always
a superset of what the app *writes*, so a staged deploy survives. The constant
is pinned by a test that states the deploy order, and the error names the remedy
("Deploy the discount Function before writing a new format") rather than just
the symptom.

### P1-15 · "The ruleset did not fit" was a one-shot query-param banner

Refusing an over-48KB ruleset is right and leaving the last good one live is
right. Telling the merchant once, through `?publishError=too_large`, was not:
one navigation later the page showed their rules as **Active** with nothing to
say checkout had a different set. The shop row already carried what was
published; nothing compared it.

**Fixed:** a persistent banner comparing `rulesetHash` — the same value
`publishRuleset` writes — against what would be published now, naming both
counts and what makes it retry.

### P1-16 · The Function read the wall clock

`const now = new Date()` inside a Function sandbox whose clock is not a
dependable source of the store's time — `shop.localTime` exists in the input
schema precisely because it is not. A fixed or epoch-zero clock would leave
every `startsAt` rule permanently `not_started`.

**Fixed:** the input query selects `shop { localTime { date } }` and the
Function reads it, at midday in the shop's zone — the instant furthest from
either day boundary, which is what the schedules are now expressed in. Falls
back to the sandbox clock, which is what there was before.

**Unverifiable here:** whether the sandbox clock is in fact wrong. The fix is
cheap and safe either way; the reviewer called it the second thing to check on
a dev store and it still is.

## Tests

| Fix   | Committed test                                                  | Probe |
| ----- | --------------------------------------------------------------- | ----- |
| P1-5  | `packages/pricing-engine/test/rounding.test.ts` (9 new)          | rounding, rounding-integer-pct |
| P1-6  | probe + `pricing-pages-states` fixtures                          | why-this-price |
| P1-7  | probe                                                            | schedule (3) |
| P1-8  | probe                                                            | cascade |
| P1-9  | `tests/unit/pricing-pages-states.test.tsx` (1 new + capture 20)  | cascade |
| P1-10 | `tests/unit/market-scoping.test.ts` (2 new)                      | — |
| P1-11 | `tests/integration/pricing-rules.test.ts` (6 new)                | — |
| P1-12 | `pricing-pages-states` (capture 22)                              | — |
| P1-13 | covered by the backfill suite                                    | — |
| P1-14 | `packages/pricing-engine/test/codec.test.ts` (5 new)             | abuse |
| P1-15 | `pricing-pages-states` (capture 21)                              | — |
| P1-16 | `extensions/mannon-discount/test/run.test.ts`                    | — |

Two probes asserted the *old* behaviour and were corrected with the reasoning
written in: the money probe pinned `parseMoney("1000.0","JPY")` throwing (fixed
in the P0 round), and the abuse probe asserted one discount candidate from a
refused ruleset, contradicting its own report text, which says zero.

## What this does not prove

Unchanged, and for the same reason — no egress to Shopify from this
environment: whether the Function sandbox's clock is actually wrong (P1-16),
and whether `shop { localTime { date } }` is selectable on the discount
Function's input under `2025-07`. Both are dev-store checks and are listed as
such rather than asserted here.

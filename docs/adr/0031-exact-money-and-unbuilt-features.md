# 31. Exact money, and what to do with a feature that is modelled but unbuilt

Date: 2026-09-18 · Status: accepted

## Context

The 1.1/1.2 cold read raised twelve P1s. They fall into two groups, and the
second is the one worth an ADR of its own.

## Part one: the arithmetic

`money.ts` opens with _"No price arithmetic anywhere in this package touches a
floating-point value, because `0.1 + 0.2` is the kind of bug that shows up as a
merchant emailing about a one-cent discrepancy six months after launch."_ Three
feet below it, `percentageEffect` returned `(100 - percentage) / 100` and the
cascade multiplied the running price by it.

Every value that should land exactly on a half-cent tie landed just below one,
and `half_up` — chosen because it is what a merchant checking the arithmetic by
hand expects — rounded it down. $10.75 with 6% off is $10.11 by hand and was
$10.10 in the engine. Measured: 13,636 wrong answers across the realistic input
space, every one a cent in the buyer's favour.

**Decision.** The running price is an exact `Fraction` — integer numerator over
integer denominator, reduced to lowest terms after each step — and an effect
carries a ratio rather than a factor. `roundFraction` decides a tie by comparing
`2 × remainder` against the denominator, which is an integer comparison; the
float path could not represent `1010.5` to compare it with anything.

Percentages are taken to hundredths of a percent. That is what the builder
accepts and what the finest golden vector uses, and the rounding happens
**there, once, in the open** — the opposite of burying it inside a multiply.

Precision is surrendered in exactly one place: a multiply that would overflow
safe integers even after reduction collapses the fraction to whole minor units
first. Reaching it takes four stacked percentage rules on a single line against
a price sharing no factor with 10,000. A test pins that three survive exactly,
so if that ever changes it changes loudly.

**The general lesson**, which is why this is an ADR and not a commit message: a
comment that states a property is not the property. This repo has now found the
same shape three times — this one, the discount Function's _"anything
unexpected costs one line, not the cart"_ sitting above a `try` outside the
loop, and `snapshotFrom`'s _"keep them working and make the mismatch loud"_
above a `return FREE_SNAPSHOT`. When a comment states a guarantee, grep for the
code that would have to enforce it.

## Part two: a model with no writer

`MarketScope` and `CurrencyAmount.overrides` were both in the engine from 1.1,
both exercised by golden vectors, and neither reachable from the product: every
production writer emitted the empty default. The vectors passed the whole time,
because they test the engine and the gap was in the product.

They got opposite treatments, and the difference is the decision.

### Multi-currency amounts: built

The harm was live. In a store selling in more than one currency, every
`fixed_price` and `amount_off` rule was skipped outside the home currency while
percentage rules carried on — so a buyer checking out in EUR lost exactly their
**negotiated contract prices** and kept the discounts. Nothing downstream
blocked a fix: the engine already reads `overrides`, and the only missing piece
was a form.

So it is a form. Typed, never converted — the engine refuses to invent an
exchange rate and so does the builder, because a figure the merchant did not
type is a price nothing else in the system agrees with.

### Market scoping: left unbuilt, with the gate moved into the parser

The blocker is downstream of the UI. The checkout Function knows the buyer's
**country**, not which Shopify Market that maps to: `Localization.market` is
deprecated and the mapping is per-shop. A market-scoped rule is therefore
dropped at checkout while the admin shows it applying — the exact disagreement
this app exists to prevent.

Building the form first would have shipped a field that quietly does nothing,
which is the failure this repo keeps finding (`pausedAt` stopping nothing at
checkout, `allowShopifyDiscounts` changing nothing, the AI permission toggles
gating a view instead of a POST).

So `parseMarkets` refuses a scope even when one is posted by hand, and
`tests/unit/market-scoping.test.ts` fails the moment any writer starts emitting
one. The unblocker is written down rather than rediscovered: publish the
country-to-market map to the Function, then take the gate off.

### The rule this leaves behind

**A capability that is modelled, tested and unreachable is a plan, not a
feature.** Deciding which of the two it becomes goes: is the harm live, and is
anything downstream of the form blocking it? Live harm plus no blocker means
build it. A blocker means leave it unbuilt, put a gate where the shape could
otherwise leak in, and name the unblocker in a test — never a form that quietly
does nothing.

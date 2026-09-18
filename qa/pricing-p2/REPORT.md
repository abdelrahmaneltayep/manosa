# QA — pricing cold read, the P2s

Date: 2026-09-18
Scope: P2-18, P2-19, P2-20, P2-21, P2-22 from `qa/1.1-1.2/COLD-READ.md`.
(P2-17 and P2-23 were already closed by earlier rounds; re-checked, still closed.)

Every fix below was verified the same way the P0 and P1 rounds were: write the
probe, watch it pass, revert the fix, watch the probe fail **for the reason the
finding gives**, restore the fix.

---

## P2-21 — the margin guard never checked cart-value rules

**The finding.** `guardMargins` priced every candidate with `cartSubtotal:
null`, so `effectFor` returned `cart_unknown` for a `cart_value_tier` rule,
`priced` stayed false, and every candidate landed in `notApplicable`. A
cart-value rule that sells below cost was reported as "not applicable", which a
merchant reads as safe.

**The fix.** `checkpointSubtotals(rule, currencyCode)` — the cart-value sibling
of `checkpointQuantities`. Each tier's own `minSubtotal` is a checkpoint, and
the candidate loop now walks quantities × subtotals.

One thing the fix had to get right and nearly did not: a cart is never smaller
than the line inside it. Checking a "$50–$99.99" tier against one unit that
costs $100 would warn about a basket no buyer can assemble, so the subtotal
used is `max(tier threshold, unit price × quantity)`.

**Probes** (`packages/pricing-engine/test/margin-guard.test.ts`, +6):

| Probe | Result |
| --- | --- |
| a cart-value tier that sells below cost is reported, not "not applicable" | pass |
| the cart is never smaller than the line inside it | pass |
| tiers priced in another currency stay unchecked, not "safe" | pass |
| `checkpointSubtotals` offers `[null]` for a rule that reads no cart | pass |
| …each tier's threshold for one that does | pass |
| …`[null]` when every tier is in another currency | pass |

**Reverted** (`checkpointSubtotals` → `return [null]`): 2 failed, including
"reports a tier that sells below cost instead of calling it not applicable".

## P2-22 — `computeNextTier` kept a cart that could not hold the quantity

**The finding.** The next-tier quote re-resolved at the higher quantity but
carried the *current* cart subtotal, so "add 8 more units" was priced against a
basket that cannot contain those units.

**The fix.** The added units are added to the cart too: the subtotal grows by
`(next.minQuantity − quantity) × base unit price`, which is the basis
`cartSubtotal` is measured in everywhere it is supplied (Shopify's
`cart.cost.subtotalAmount`, the quote builder, the preview). A cart in another
currency is passed through untouched — the engine does not convert, and a
next-tier quote is not the place to start.

**Probes** (`packages/pricing-engine/test/next-tier.test.ts`, new, 3):

| Probe | Result |
| --- | --- |
| the next break is priced in the cart the added units would make ($4.50, not $9.00) | pass |
| a context with no cart still has no cart at the next quantity | pass |
| units in USD are not added to a subtotal counted in EUR | pass |

**Reverted**: 1 failed — `expected 9.00 to be 4.50`.

## P2-20 — checkout named only the first rule of a stack

**The finding.** The Function's discount message read `appliedRuleIds[0]`, so a
buyer whose price moved twice saw one rule's name. Invariant 5 on the buyer's
side.

**The fix.** `discountMessage(names)` joins every applied rule's name in
cascade order. Shopify caps the message at 255 characters, so the function
takes the longest run of names that fits **together with** the "+ N more" that
accounts for the rest — the count is checked before a name is added, never
squeezed out by the name that would not fit. A single name longer than the cap
is cut to it, because Shopify would cut it anyway at a length we do not choose.

**Probes** (`extensions/mannon-discount/test/run.test.ts`, +5):

| Probe | Result |
| --- | --- |
| two stacked rules both appear in the message | pass |
| no applied rule → "Wholesale price" | pass |
| names join in the order they applied | pass |
| what will not fit is counted, not sliced mid-word | pass |
| the count survives when only the first name fits | pass |
| one over-long name is cut to exactly 255 | pass |

**Reverted** (`message: names[0] ?? …`): 1 failed — `expected 'Wholesale 35%
off' to be 'Wholesale 35% off + Autumn clearance'`.

## P2-19 — the golden vectors bypassed the codec

**The finding.** `golden.test.ts` built `PricingRule` objects directly, so the
wire format the checkout Function actually reads was exercised only by
`codec.test.ts`. Every vector would have passed against a codec that dropped
`excludeCollectionIds` — the exact field P0-1 turned on.

**The fix.** Every vector's rules now go
`buildRule → serializeRule → JSON round-trip → deserializeRule` before they are
priced. The `JSON.parse(JSON.stringify(…))` is the trip through the metafield,
and it turns `Date`s into strings exactly as Shopify does. A rule the codec
cannot read fails its vector by name.

**Probe.** Not a new test — the whole vector file is the probe now.
**Reverted** (`serializeRule` drops `excludeCollectionIds`): 1 failed —
`rule-from-a-sentence-excludes-sale-items`. Before this change that same break
was invisible to all 41 vectors.

## P2-18 — the "rounding happens once" vector could not detect per-step rounding

**The finding.** `rounding-happens-once-at-the-end-not-per-rule` said "two
33.33% rules must agree with the maths" and then listed **one** rule. With one
rule the two behaviours are identical by construction, so the headline property
of `resolve.ts` had no test.

**The fix.** Two new stackable 33.33% rules and a vector that uses both:
$10.00 × 0.6667 × 0.6667 = 4.4449 → **$4.44**. Rounding each step gives $6.67
then $4.45 — one cent, in the merchant's favour, every time. The old vector's
`why` no longer claims to test something it does not; it now says what it does
test (120.00 − 33.33% = 80.004 must land on 80.00) and points at its sibling.

**Reverted** (`state.price = wholeUnits(after.amount)` after each effect —
i.e. rounding per step): 1 failed —
`rounding-happens-once-across-two-stacked-rules`. The old single-rule vector
passed throughout, which is the finding.

---

## Invariants

1. **Every price from the engine** — held. Three of the five fixes are inside
   the engine; the fourth (checkout naming) touches no number; the fifth is a
   test harness change.
2. **Shop scoping** — untouched; nothing here reads the database.
3. **AI drafts, a person approves** — untouched.
4. **Nothing claims to have happened that did not** — this round is almost
   entirely this invariant: a cart-value rule reported as "not applicable", a
   next-tier price for a cart that cannot exist, and a stacked discount named
   after one of its two rules are all the app stating something untrue.
5. **Deciding shows its working** — P2-20 directly; the buyer now sees every
   rule that moved their price.

## Suite

`npx vitest run` — **135 files, 2390 tests, all passing.**
`npm run lint` clean, `npx tsc --noEmit` clean, `npx prettier --check .` clean.

## What this round does not prove

The checkout message is verified against the Function's own input fixtures, not
against a real checkout: this environment cannot reach Shopify, so nobody has
seen the string render. The 255-character cap is Shopify's documented limit,
taken on trust.

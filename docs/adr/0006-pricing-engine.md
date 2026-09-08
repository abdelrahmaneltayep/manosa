# ADR 0006 — The pricing engine

**Status:** accepted (phase 1.1)

## Why it is a separate package

`{ customer, product, quantity, market } → price` is answered in five places:
the Shopify discount Function at checkout, the storefront price blocks, the
Buyer Agent's tools, the PO parser, and the admin's live preview.

If any two of them computed a price independently they would eventually
disagree, and the failure would be the worst kind: the agent quotes $8.80, the
cart charges $9.50, and the buyer stops trusting both. So there is one module,
it is pure, and everything else calls it.

`packages/pricing-engine` therefore has **no dependencies, no I/O, and no Node
built-ins**. `test/purity.test.ts` asserts that at runtime and an ESLint rule
catches it while you type — the guarantee is load-bearing, not aspirational.

## Money is integer minor units

A price is `{ amount: <whole minor units>, currencyCode }`. No floating-point
value is ever a price. `0.1 + 0.2` is how a one-cent discrepancy reaches a
merchant's inbox six months after launch.

Consequences worth stating:

- Currency exponents are per-currency, so JPY (0) and KWD (3) are handled, not
  assumed to be 2.
- `parseMoney` **refuses** more precision than the currency has rather than
  truncating. Truncation is a rounding decision, and a rounding decision hidden
  inside a parser is one nobody reviews.
- `multiplyMoney` takes only whole factors (a quantity). Percentages go through
  the resolver, which rounds explicitly.

## The engine never converts currency

A rule priced in USD has no meaning in EUR unless the merchant has said what it
is. Rather than applying a rate we invented, an absolute-money rule in an
unpriced currency is **skipped**, with the reason `no_price_in_currency` in the
trace.

Percentage rules need no conversion and apply in every currency.

This is the same principle as "the agent can never invent a price", applied one
layer down. A converted price would be a number nothing else in the system
agrees with.

## Cascade, priority and determinism

Precedence is **custom price > volume tier > cart-value tier > discount**. A
negotiated contract price is a promise; a percentage rule must not quietly
override it. Amount-off and percentage share a rank — both are "a discount",
and which wins between them is the merchant's call, expressed as priority.

Rules are totally ordered by `(class, priority, createdAt, id)`. Lower priority
number wins, because merchants drag a rule up a list to make it matter more.
The `id` tiebreak means the same rules in any order always resolve identically —
a property test asserts it. Without that, a merchant's "why did this change?"
would be unanswerable.

## Combination

The first rule that can apply is the winner.

- Winner not combinable → nothing else applies (`not_combinable_with_winner`).
- Winner combinable → later rules apply only if they are also combinable
  (`not_combinable` otherwise). Stacking is opt-in from both sides.

A rule that cannot produce an effect — no matching tier, no price in this
currency — does not become the winner; the next rule still gets its chance.

## Rounding once, and a floor at zero

The running price is kept in fractional minor units and rounded **once, at the
end**. Rounding each step compounds the error, and a stack of three rules would
land a cent or two away from the arithmetic a merchant does by hand. Default is
half-up; the mode is a parameter because Settings exposes multi-currency
rounding (spec §8).

A price never goes below zero. When stacking hits the floor, `clampedAtZero` is
set — which is what the combination warning in the rule builder is for.

## The trace is an output, not a debug aid

Every resolution returns which rules were considered, which applied, and a
**reason code** for each that did not. `Why this price?` in the admin (§2), the
Buyer Agent explaining a price to a buyer (§6), and the conflict explainer all
read the same trace. A property test asserts no rule is ever skipped without a
reason: a blank reason is a dead end for the person asking.

## Cart-value rules stand aside when there is no cart

A product page has no cart. Guessing a subtotal would show a price checkout will
not honour, so those rules skip with `cart_unknown`.

## Testing

- `test/golden/vectors.json` — 41 cases, written from the spec's own examples
  **before** the resolver existed, each citing where in the spec it comes from
  and what it protects. Changing an expectation changes what a merchant is
  charged, so it needs an argument in the pull request rather than a re-record.
- `test/properties.test.ts` — the invariants vectors cannot cover: never
  negative, always whole minor units, independent of input order, deterministic,
  every rule accounted for in the trace, inactive rules inert, irrelevant rules
  harmless.

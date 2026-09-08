# ADR 0008 — Storing and editing pricing rules

**Status:** accepted (phase 1.3)

## Storage is the engine's own shape

`PricingRule` rows keep `value`, `targets`, `audience` and `markets` as JSON in
exactly the wire shapes from `@mannon/pricing-engine`'s codec. A row becomes an
engine rule through `deserializeRule` — the same function that reads the
published ruleset at checkout.

The alternative, columns per rule type, would mean a second definition of what a
rule is, and two definitions drift. This way a round trip through Postgres is
covered by the codec's own tests, and adding a rule type is a change in one
place.

## Saving publishes

`createRule`, `updateRule`, `archiveRule` and `reorderRules` all call
`republish` when the change affects a live rule. Nothing else keeps checkout in
step with the admin: a rule that is not published simply does not exist at
checkout, so publishing is part of saving rather than a later reconciliation.

`restoreRule` and `deleteRule` deliberately do not publish — a restored rule
comes back as a **draft**, and only an archived rule can be deleted, so neither
was in the published set.

## Concurrency

Every row carries a `version`, bumped on save. A save built on a stale version
is refused with `RuleConflictError`, which carries the current row so the
builder can show what the other person saved and offer "overwrite with mine" or
"keep theirs".

The check and the write are a single `updateMany` on `(id, version)`, so two
staff saving at the same instant cannot both believe they won. A silently
overwritten pricing change is the kind of thing discovered from a customer's
invoice.

## Deliberate deviations from checklist §2

**Virtualised list past 250 rules → server pagination at 50.** Virtualising
means rendering 250+ rows into the DOM and hiding most of them; paginating
means never building them. The goal — that a big catalogue of rules stays fast —
is better served by the second, and it costs less complexity.

**Drag-to-reorder → move up/down plus a submitted order.** Reordering has to
work from a keyboard and on a phone, where merchants approve things. The form
submits the order as a list, so pointer dragging can be layered on later as an
enhancement without changing the server contract.

**Market scoping is not offered in the builder.** The discount Function cannot
evaluate market-scoped rules yet (ADR 0007), so offering the control would let a
merchant build a rule the admin shows applying and checkout ignores. Leaving it
out means the two cannot disagree. The engine and the storage handle it; only
the control is withheld, until the country-to-market map exists.

**No cached-list fallback in the loader.** The checklist's "fetch fail → keep
the last list, marked cached" assumes the list comes from Shopify. Ours comes
from our own database, where a failure is a 500 rather than a chance to show
stale data. The state exists in the component for the surfaces that _do_ read
from Shopify; the rule list does not use it.

## "Unused" means unused, not new

A rule with no uses is only flagged after 30 days. Marking a rule created
yesterday as unused would be telling the merchant something untrue.

Until analytics land (6.1) usage is `null` — _not measured_ — which renders as
an em dash with a screen-reader explanation, never as a zero. Zero and "we have
not counted yet" are different facts and the merchant deserves the difference.

## Product and collection metafields

`products/update` and `collections/update` republish a product's collection
membership, which is what lets the Function evaluate collection targeting. A
product removed from a collection fires `products/update`; a collection whose
rules sweep products in fires `collections/update`, and only the products now in
it are refreshed — re-reading a whole catalogue on every collection edit would
cost far more than the case it fixes.

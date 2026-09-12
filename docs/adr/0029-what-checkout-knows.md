# 29. Everything checkout knows, it knows from a metafield — and so does everything else

Date: 2026-09-12 · Status: accepted

## Context

A Shopify Function's input query is fixed at deploy time. It serves every
merchant on the app, so nothing in it can depend on one shop's configuration:
the discount Function cannot be handed a merchant's collection list, or their
buyer tags, or their rules. Everything it needs therefore arrives as a
**metafield this app writes** — `$app:mannon.ruleset` on the discount node,
`$app:mannon.buyer` on the customer, `$app:mannon.collections` on the product.

ADR 0007 settled that. What it did not settle is the two consequences that made
a buyer see one price and be charged another, both of which were live from
milestone 1 to milestone 7.

## Decision

### A metafield needs a webhook _and_ a backfill. The backfill is part of the feature.

A webhook fires on **change**. The metafield writers were `products/update` and
`collections/update`, so on a store that installed Mannon with a catalogue it
already had, every product reached checkout with no collections at all — until
somebody happened to edit it in Shopify admin.

That is not a slow start; it is a wrong price in the expensive direction.
_"20% off everything except Sale"_ is the most ordinary wholesale rule there
is, and with no membership the exclusion excludes nothing — so the discount
lands on exactly the products the merchant protected.

Customers and orders each had a backfill from the start. Products did not, for
seven milestones, and nothing failed. **If a fourth such fact is added, its
backfill ships with it**, and the admin says so while it runs: a half-finished
publish is a wrong price for a reason the merchant can see, and Invariant 4
says they are told.

### Everything outside checkout reads the same metafield, not Shopify.

`packages/pricing-engine` is pure and answers the context it is given. The bug
was never in it: four callers — quick order, quotes, the Buyer Agent,
PO-to-order — handed it `collectionIds: []`, hardcoded in the one function they
share. So "one module, one answer" still produced four different prices for the
same buyer and the same line, and a quote, which is a promise, locked the wrong
one for ever.

The obvious fix is to ask the Admin API what collections the product is in.
That is the wrong fix, and the reason is worth writing down: it would be
**fresher than the metafield**, so on any product the backfill has not reached,
the storefront would confidently show a price checkout will not honour. When a
buyer is shown a number they will later be charged, agreeing with the thing
that charges them beats being right sooner.

So every surface reads `$app:mannon.collections`, through one module
(`app/lib/pricing/product-collections.server.ts`). A stale value makes both
sides stale **together** — one correctness problem with one owner and one fix,
rather than a disagreement between two subsystems that nobody can reproduce.

### Where a caller cannot be allowed to omit a field, the type requires it.

`collectionIds` is required on `QuoteLineRequest`. A default of `[]` is what
caused this: it looked like a sensible fallback and was a silently wrong price.
Making it required found all eight call sites in one `tsc` run, two of which
nobody had thought about — including the quote builder's add-line form, which
was dropping `productId` for the same reason and losing every product-scoped
rule with it.

## Consequences

- A `products.backfill` job, enqueued at install and again at reinstall (the
  metafields a previous install wrote are stale, and stale reads to checkout
  exactly like correct).
- One batched Admin call on a product page, and only when a rule actually uses
  collections — a store with none pays nothing.
- `QuoteLine.collectionIds` is stored with the price, because the drift figure
  beside a quote re-prices that line and must re-price the same product.
- The Pricing page carries a banner naming how many rules use collections and
  how many products have been published, while the backfill runs.

## Rejected

- **Sending `product.collections` from Liquid.** Free and current, and wrong
  for the freshness reason above. It also cannot be verified against
  `shopify.dev` from this build environment.
- **A mirrored `Product` table.** A third copy of a fact Shopify already owns,
  with its own sync to go wrong.
- **Leaving the backfill as a follow-up.** It is the half of the feature that
  makes the other half true.

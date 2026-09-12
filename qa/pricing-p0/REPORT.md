# QA — the four pricing P0s from `qa/1.1-1.2/COLD-READ.md`

**Date:** 2026-09-12
**Scope:** the four P0s the 1.1/1.2 cold read raised, plus one bug of the same
class found while fixing them.
**Verdict:** all four fixed, each with a test that fails without its fix.
**Architecture:** `docs/adr/0029-what-checkout-knows.md`.

## What was wrong, and what now happens

### P0-1 Collection membership was never backfilled

`$app:mannon.collections` is the only channel by which the checkout Function
learns what is in a collection — its input query is fixed at deploy time. The
only writers were the `products/update` and `collections/update` webhooks,
which fire on _change_. A store installing Mannon with ten thousand existing
products sent every one of them to checkout with no collections at all.

The direction that costs money is the exclusion: with no membership, _"20% off
everything except Sale"_ excludes nothing, so the discount lands on exactly the
products the merchant protected.

**Fixed:** a `products.backfill` job
(`app/lib/jobs/handlers/backfill-products.server.ts`), enqueued from
`ensureShopRecord` at install and again at reinstall, paging 25 products at a
time — one read and one write per page rather than two calls per product. A
product in more collections than one read returns gets its own paginated pass
rather than being published short. Progress is on `Shop`
(`productsBackfilledAt`, `productsBackfillCursor`, `productsPublished`).

And because a half-finished backfill is a wrong price for a reason the merchant
can see, the Pricing page now says so: a banner naming how many rules use
collections and how many products have been published. It appears only while
the backfill is unfinished **and** a rule actually depends on collections.

### P0-2 The buyer was shown one price and charged another

`app/lib/quotes/pricing.server.ts` hardcoded `collectionIds: []` — in the one
function that prices quick order, quotes, the Buyer Agent and PO-to-order. With
the rule above and a sale item: the quick-order block showed **$8.00**,
checkout charged **$10.00**. A quote locked the wrong number permanently.

**Fixed, and fixed by construction.** Every surface now reads the **same**
`$app:mannon.collections` metafield the Function reads, through one module
(`app/lib/pricing/product-collections.server.ts`) — so if the value is stale
both are stale together and they cannot disagree about the same product. A
second lookup would have been a second answer.

- `collectionIds` is **required** on `QuoteLineRequest`. The type found all
  eight call sites; a caller that does not know has to say `[]` out loud.
- The SKU lookup (`quick-order.server.ts`) and the variant search
  (`quotes/admin-graphql.server.ts`) both select the metafield, so quick order,
  the Buyer Agent, the quote builder and PO-to-order carry it through.
- `QuoteLine.collectionIds` stores it, because the drift figure beside a quote
  re-prices that line and has to re-price the same product.
- `proxy.variants` (the theme's variants table sends ids, not product nodes)
  reads the metafield in one batched call — and only when a rule actually uses
  collections, so a store with none pays nothing for it.

**Found in passing, same class:** the quote builder's "add line" form dropped
`productId` as well (`productId: null`, hardcoded), so a hand-added line lost
every product-scoped rule too. Both now travel through the form.

### P0-3 One unparsable money string killed the whole cart's discounts

`parseMoney` throws on excess precision, by design. The Function fed it
Shopify's `MoneyV2.amount` strings unnormalised, under a single top-level
`try`. Two consequences, both silent:

1. Shopify serialises `MoneyV2.amount` with a decimal point whatever the
   currency, so a ¥1,000 line arrives as `"1000.0"`. JPY allows no decimals →
   throw → no operations → **every wholesale buyer in a zero-decimal-currency
   store paid retail, for ever.**
2. `discountFor` was called in the loop but guarded only by the try around the
   whole run, so one odd amount removed the discount from every other line —
   the opposite of what the file's own header promises.

**Fixed:**

- `parseMoney` accepts **trailing zeros** past the currency's exponent.
  `"1000.0"` JPY is exactly 1000 yen; nothing is rounded away. A _significant_
  digit past the exponent still throws, which is the rule that matters.
- The Function guards each line: an unreadable amount costs that line and logs
  it. An unreadable cart subtotal returns `null`, which makes the engine skip
  cart-value tiers and apply everything else.

### P0-4 The discount was created without `discountClasses`

The Function's first statement refuses everything unless `PRODUCT` is in
`input.discount.discountClasses`, and the create mutation did not send the
field at all — so the app's own discount was never granted the one class it
exists to produce. It ran on every cart and was permitted to produce nothing.

**Fixed:** `discountClasses: ["PRODUCT"]` on the create, and nothing else —
Mannon changes a line's unit price, and asking for the order or shipping class
would let a future bug apply one. Shops whose discount predates this are
repaired once and stamped (`Shop.discountClassesAt`), so it costs one Admin
call per shop and nothing afterwards.

The repair runs from the `/app` layout loader, **not** only from
`ensureDiscount`. That distinction is the fix: `ensureDiscount` runs when rules
are published, so a merchant whose rules were already set up would have had no
wholesale pricing at checkout at all, for ever, with nothing anywhere telling
them to go and edit a rule. A repair that fails is logged and left unstamped —
the next page view tries again, and nobody gets an error page over it.

**Still unverifiable from here.** This environment cannot reach `shopify.dev`
or a dev store, so whether Shopify accepts the field under `2025-07` and what
it does with it is checked on a real store or not at all. The one-line check is
in the cold read. What _is_ proved here is that the app sends it.

### Found while fixing P0-3: order limits were 100× wrong in yen

`extensions/mannon-limits/src/run.ts` read the cart with a hardcoded
`Math.round(amount * 100)` for every currency, while the app stores limits
through `parseMoney`, which knows each currency's exponent. So a ¥1,000 cart
came to 100,000 minor units and cleared a ¥1,000 minimum it should have
failed — on every yen store, every time. Both sides now use the same parser.

## Tests

| Fix                             | Test                                                                  | Fails without the fix                       |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| P0-1 backfill                   | `tests/integration/products-backfill.test.ts` (7), `tests/unit/pricing-pages-states.test.tsx` (2 new, 1 capture) | the job did not exist                       |
| P0-2 shown = charged            | `tests/integration/storefront.test.ts` (3 new), `tests/unit/product-collections.test.ts` (11) | ✓ `expected '$8.00' to be '$10.00'`         |
| P0-3 zero-decimal currencies    | `packages/pricing-engine/test/money.test.ts` (3 new)                  | ✓ 2 fail                                    |
| P0-3 Function money             | `extensions/mannon-discount/test/run.test.ts` (3 new)                 | ✓ 3 fail                                    |
| P0-4 discount classes           | `tests/integration/ruleset-publish.test.ts` (5 new)                   | ✓ 2 fail                                    |
| limits currency                 | `extensions/mannon-limits/test/run.test.ts` (3 new)                   | ✓ 2 fail                                    |

Each fix was reverted in place and the suite re-run to confirm the new tests
fail for the stated reason, not incidentally. The results are quoted above.

## What this does not prove

The same thing every report in this repo has to say: this environment has no
egress to Shopify. The Function is a plain `(input) => output` and is genuinely
exercised, so its behaviour at checkout is real. But `discountClasses` on
`DiscountAutomaticAppInput`, `MoneyV2.amount`'s exact serialisation for a
zero-decimal currency, and whether `products(first: 25) { collections(first:
250) }` stays inside Shopify's query-cost ceiling on a large store are three
things only a dev store can answer. They are listed in `PROGRESS.md` under the
dev-store blocker, not asserted here.

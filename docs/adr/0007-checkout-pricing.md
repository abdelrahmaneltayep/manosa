# ADR 0007 — Getting wholesale prices to checkout

**Status:** accepted (phase 1.2)

## The constraint everything follows from

Shopify Functions cannot call our API, and a Function's **input query is fixed
at deploy time** — one query serves every merchant. So `Customer.hasAnyTag` and
`Product.inAnyCollection` are useless to us: both take a list we would have to
bake in, and merchants change theirs daily.

Everything the Function needs at runtime therefore has to arrive as **data on
the objects it can already see**: metafields.

## What lives where

| Metafield                 | Owner                  | Written by          | Read for                                |
| ------------------------- | ---------------------- | ------------------- | --------------------------------------- |
| `$app:mannon.ruleset`     | the automatic discount | `publishRuleset`    | Every rule, in the engine's wire format |
| `$app:mannon.buyer`       | customer               | `publishBuyerFacts` | Tags and groups, for audience matching  |
| `$app:mannon.collections` | product                | phase 1.3           | Collection membership, for targeting    |

The ruleset lives on the **discount node** rather than the shop so the
configuration travels with the discount it drives — the same place Shopify's
own function examples put a function's configuration.

## The Function computes nothing

`cartLinesDiscountsGenerateRun` reads the ruleset, builds a `PricingContext`
per cart line, and calls `resolvePrice` from `@mannon/pricing-engine` — the
same module the admin preview and the Buyer Agent call.

That is the whole point. If the Function had its own pricing logic, the agent
could quote $8.80 while checkout charged $9.50, and a buyer who noticed once
would stop trusting both. A test asserts the two agree across percentage,
fixed-price, stacked and rounding cases.

The engine returns a per-unit price; the Function expresses the difference as
`fixedAmount` with `appliesToEachItem: true`, so quantity multiplies exactly
rather than through a percentage that rounds twice.

## It never throws

A discount Function that fails applies **no discounts at all** — every
wholesale buyer in that store quietly pays retail until a human notices. So:

- `deserializeRuleset` never throws; one malformed rule costs that rule.
- The entry point wraps everything and returns no operations on any unexpected
  error, logging it.
- A rule that would _raise_ the price emits nothing: a discount cannot express
  it, and a buyer would not accept it from one.

Wrong-but-visible beats wrong-but-silent, and the shelf price is the visible
failure.

## Market scoping is deliberately not applied yet

The Function knows the buyer's country but not which Shopify Market that maps
to — `Localization.market` is deprecated and the mapping is per shop. Rather
than guess, market-scoped rules are **dropped at checkout**, with a warning.

Dropping is the safe direction: an `exclude` rule evaluated with no market id
would match everywhere and hand out a discount the merchant had scoped away.
Publishing a country-to-market map is a dependency of 1.3.

## Publishing

`publishRuleset` is the only thing keeping checkout in step with the admin —
anything not published does not exist at checkout. It:

- creates the automatic discount once per shop and remembers its id;
- hashes the payload so an unchanged ruleset costs no API call;
- **refuses** a ruleset over 48 KB rather than letting Shopify truncate a
  metafield into silently wrong prices, leaving the last good ruleset live;
- writes an audit entry saying how many rules are now live.

Every Admin API call goes through one seam (`AdminGraphql`) so tests pin the
exact mutation and variables. These calls cannot be exercised without a real
store, so pinning the request is the strongest guarantee available until the
dev-store run.

## Buyer facts

Tag changes are how a merchant approves someone for wholesale, so
`customers/create` and `customers/update` republish the buyer metafield. Tags
are normalised — trimmed, de-duplicated, sorted — so an unchanged buyer always
produces an identical value and no pointless write.

Until a buyer's facts are published, tag-targeted rules do not apply to them at
checkout even though the admin shows the right price. That is exactly the
disagreement this app exists to prevent, which is why it is webhook-driven
rather than periodic.

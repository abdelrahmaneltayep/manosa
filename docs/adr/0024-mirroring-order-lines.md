# 24. Mirroring order lines, and what a rule earned

Status: accepted (phase 6.1)

## Context

Checklist §7 asks for six charts. Two of them cannot be drawn from anything
this app holds:

> top buyers/**products**, **rule performance**

`Order` carries totals and a customer, and nothing below that. There is no line
item anywhere in the schema, so "which products do Gold buyers buy that Silver
don't" and "usage and revenue per pricing rule" — the two questions §7 leads
with and the ✦ ask-your-data feature is built on — have no data to answer from.

Asking Shopify per chart is not an option either. An analytics page that reads
line items from the Admin API on render costs one request per order per view,
against a rate limit, for a query whose answer does not change.

## Decision

### The lines are mirrored, like the orders already are

`OrderLine` holds what the buyer was actually charged: quantity, unit price,
the line before discounts and after them, and the product and variant GIDs.
Everything in it is Shopify's number — **nothing here comes from the pricing
engine**, and nothing is computed by this app. These are receipts, not prices:
invariant 1 is about what we charge, and this table is about what was charged.

The product title, variant title and SKU are denormalised onto the row. A
product deleted in Shopify still sold last March, and a chart that forgets it
under-reports the past.

### A rule's performance is read from the name the buyer saw

There is one automatic discount per shop — "Mannon wholesale pricing" — so the
discount itself cannot say which rule fired. What can is the Function: it
already sets `message: winningRule.name` on every line it discounts, and
Shopify reports that as the discount application's title on the order.

So `OrderLine.discounts` is `[{ title, amount }]`, and rule performance groups
by title. Three consequences, all of them stated on the page rather than papered
over:

- **A renamed rule does not rewrite its own history.** Last quarter's lines
  still carry last quarter's name. This is the right way round — the name is
  what the buyer was shown — but it means the chart joins to current rules by
  name and has to say when it cannot.
- **A discount Shopify named neither by title nor by code** becomes
  `(unnamed discount)` rather than being dropped. Dropping it would make a
  line's discounts stop adding up to the difference between its two totals,
  which is the arithmetic every one of these charts rests on.
- **Rule performance starts when the Function started.** Orders older than the
  Function's first run carry no Mannon discount at all.

### Both doors, and the trap in one of them

The webhook payload and the GraphQL node describe the same line differently,
and the payload is the awkward one: it carries a **per-unit** price and no line
totals, and its allocations name their discount by **index into an array on the
order**. So `linesFromWebhook` multiplies and resolves indices; `linesFromNode`
reads the three money fields Shopify gives directly and multiplies nothing — a
total this app computed would disagree with Shopify's the first time a line
carried a fractional discount.

The two are asserted to produce identical facts from the same order.

### Lines are replaced, never reconciled

An edited order loses lines as well as gaining them, and an upsert-only pass
leaves the removed ones behind — as revenue, on a chart, for a product the
merchant never sold. So the write is delete-then-create, inside the same
transaction as the order, and an order never exists with half its lines.

The exception: **a payload carrying no lines leaves the ones we have alone.**
Some order webhooks (a fulfilment, a cancellation) arrive without `line_items`,
and reading that as "this order has no lines" would empty the table one event
at a time.

### An incomplete line set says so

Lines are fetched with a cap per order rather than paginated inside a page of
orders — the alternative turns one backfill into thousands of round trips. A
wholesale order with more distinct SKUs than the cap therefore arrives short,
and `Order.linesTruncated` records it, so a chart built on lines can say it is
missing some.

**The signal is Shopify's, not ours.** Through the GraphQL door it is
`lineItems.pageInfo.hasNextPage`; through the webhook door, where there is no
pagination at all, it is the payload sitting exactly on the webhook's own line
cap, which means "we cannot tell" rather than "that is all of them".

The first version compared the quantity the lines added up to against the
order's own, and that was wrong twice over. Through the webhook door both sides
were summed from the _same_ array, so the comparison was structurally incapable
of ever being true. Through the GraphQL door the order's quantity is
post-refund while the lines' is pre-refund, so a refunded order flagged itself
as truncated. Every test for it passed because every test hand-injected a
`totalQuantity` neither door can produce — a fixture that sets a value the
production writer never sets is a test that cannot fail.

That flag is only ever set from a payload that actually carried lines. Letting
a line-less fulfilment webhook set it would mark a perfectly mirrored order as
incomplete — the same trap as the paragraph above, one column along.

## Consequences

- One new model, shop-scoped by the tenant extension like everything else, and
  cascading from `Order`, so deleting an order takes its lines with it.
- One new column on `Order`.
- The install backfill already runs every order through `factsFromNode` and
  `upsertOrder`, so it now brings lines with it and no separate backfill exists.
  **An install that predates this change keeps line-less orders until its
  backfill is re-run** (clear `ordersBackfilledAt` and `ordersBackfillCursor`,
  enqueue `orders.backfill`). No such install exists — this app has never been
  deployed to a real store — which is the only reason that is a note rather than
  a migration.
- `read_products` is already among the scopes the orders query needs; the line
  fields add no new scope beyond what `read_orders` grants.
- Phase 7.2's GDPR redaction has one more table to reach. Lines hold no personal
  data themselves, but they hang off an order that does, and the cascade is what
  covers them.

---

## Addendum (6.1 fix round): what the cold read found

An independent review returned **FAIL** with seven findings, three of them
serious enough to change the design.

### The mirror over-reported revenue after a refund

`quantity`, `originalTotalSet` and `discountedTotalSet` are all defined by
Shopify as **before returns and removals**. The parent `Order` row is written
from the `current_*` fields, so the lines and the order they belong to
disagreed: a five-unit line the merchant refunded in full was still five units
of revenue on every product and rule chart while the order said the money had
gone back.

Shopify exposes no post-refund line total, so `OrderLine` now carries
`currentQuantity` (which it does expose) and a `currentTotal` apportioned from
it — `discountedTotal × currentQuantity / quantity`, rounded **down** so an
apportioned total can never exceed what the merchant actually kept. Computed
once at write time rather than in every chart, so there is one place it can be
wrong and one place to test it. The charts read `currentTotal`; a line whose
whole quantity went back earns its rule nothing.

### The query was about a hundred times over Shopify's cost ceiling

Shopify's calculated query cost multiplies a connection by its `first`, so
`lineItems(first: 100)` nested inside `orders(first: 100)` costs on the order
of tens of thousands of points against a **1,000-point single-query maximum**.
Schema-valid, and rejected at runtime every time: every page of the backfill,
every retry, leaving the merchant with an empty Orders page and empty charts
and nothing to explain them.

"Validated against the schema" is a different property from "will execute", and
the first report conflated them. The page is now 10 orders × 50 lines, with the
arithmetic written down beside the constants; the backfill re-queues per page,
so the only cost of a smaller page is more runs.

### Money that could not be parsed became zero, silently

`readMoney` swallowed every `parseMoney` failure and returned zero with no log.
The parser is strict about precision on purpose — it guards our own arithmetic
— but Shopify is a boundary, and it sends `"5000.00"` for a zero-decimal
currency like JPY. That parsed as a failure, and a ¥5,000 line was mirrored as
¥0 on every chart. `parseShopifyMoney` now trims the insignificant trailing
zeros at that boundary and **logs** anything it still cannot read.

### The rest

A discount carried in `total_discount` with no allocation entry — which is how
an accepted quote's own discount arrives — was ignored, so the line mirrored at
full price. `createMany` had no `skipDuplicates`, so a payload repeating a line
item id rolled the entire order back and 500'd a webhook Shopify then
redelivers, to fail the same way. And the "both doors agree" test used
`10.00 × 10`, the one fixture shape where a multiplying reader and a reading
one cannot possibly disagree; it now uses `3.33 × 7`.

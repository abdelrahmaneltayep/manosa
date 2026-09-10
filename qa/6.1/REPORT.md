# QA — 6.1 Mirroring order lines

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

> **Status: clean pass, after a FAIL and a full fix round.** The independent
> cold read returned **FAIL** on seven findings, three of them serious: the
> mirror over-reported revenue after any refund, the truncation flag could
> never be true through the webhook door, and the orders query was roughly a
> hundred times over Shopify's 1,000-point cost ceiling — schema-valid and
> rejected at runtime every time. All seven are fixed; the evidence is in
> `qa/6.1/COLD-READ.md` and §8 below. This is the second run.
>
> One claim in the first version of this report was **misleading** and is
> corrected in §8: "validated against Shopify's own schema" is a statement
> about schema validity, not about whether the query will execute. It would
> not have.

## 1. Scope, and why this task exists at all

Checklist §7 asks for six charts. Two of them — **top products** and **rule
performance** — have no data to draw from: `Order` carries totals and a
customer and nothing below that, and there is no line item anywhere in the
schema. This task is the foundation those two charts need, and nothing else.
No screen ships here; §3 has nothing to walk, which is said plainly rather than
padded with captures of something else.

What is in it: an `OrderLine` model, line items on the orders GraphQL query,
readers for both doors (webhook and GraphQL node), a replace-not-reconcile
write inside the order's own transaction, and `Order.linesTruncated` for the
orders whose lines did not all come through.

## 2. Test plan

Spec re-read: `feature-checklist.md` §7, `docs/adr/0024` (written for this),
and `CLAUDE.md` → Invariants 1, 2 and 4.

**Happy paths.** An order arrives by webhook and its lines are mirrored. The
same order arrives through the backfill's GraphQL node and produces identical
facts. A rule's name reaches `discounts` so rule performance is measurable.

**States and edges:**

| Condition                                        | What happens                          |
| ------------------------------------------------ | ------------------------------------- |
| Line with no title, product, variant or SKU      | still named, still counted            |
| Line with no money fields at all                 | zeroes, no throw                      |
| Discount with a title                            | the rule name the buyer saw           |
| Discount with only a code                        | the code                              |
| Discount with neither                            | `(unnamed discount)`, money kept      |
| Allocation index pointing outside the array      | `(unnamed discount)`, money kept      |
| Allocations exceeding the line                   | clamped at zero, never negative       |
| Line with no id of any kind                      | dropped, not mirrored twice           |
| Order edited down to fewer lines                 | the removed line is gone              |
| Webhook carrying no `line_items`                 | existing lines untouched              |
| Order with more lines than the page cap          | `linesTruncated` set                  |
| Order deleted                                    | lines cascade                         |

**Three abuse cases I invented:**

1. **A payload designed to make the arithmetic lie.** A per-unit price with a
   quantity, allocations that exceed the line, an allocation index of 7 into an
   empty array, and a line whose `discount_allocations` is null — every one of
   them a way to get a chart to report money that was never taken or to lose
   money that was.
2. **An order that changes shape.** The same order redelivered (webhooks are
   at-least-once), then edited down to one line, then updated by a payload with
   no lines at all. Ghost lines, duplicates, and an emptied table are the three
   failures.
3. **Two shops, the same Shopify order id.** α and β both mirror
   `gid://shopify/Order/5001` with different lines; neither may see or overwrite
   the other's.

## 3. Automated

New:

- `tests/unit/order-lines.test.ts` — 17
- `tests/integration/order-lines.test.ts` — 8

Properties worth naming:

- **Both doors agree.** The webhook payload and the GraphQL node for the same
  order produce identical `lineItemId`, quantity, unit price, both totals and
  discounts. Asserted field by field, because the payload's shape is the
  awkward one and a divergence here is a chart that changes depending on which
  webhook happened to arrive.
- **Nothing here computes a price.** The GraphQL reader multiplies nothing —
  Shopify gives all three money figures and a total this app derived would
  disagree with Shopify's the first time a line carried a fractional discount.
  The webhook reader multiplies because the payload has no line total, and that
  is the only multiplication in the feature.
- **A discount is never lost.** Every path that fails to name one still keeps
  its amount, so a line's discounts continue to add up to the difference
  between its two totals — the arithmetic all four of the dependent charts rest
  on.
- **Revenue never goes backwards.** A line whose allocations exceed it clamps
  at zero.
- **Redelivery is a no-op.** Two upserts of the same order leave two lines and
  one order.
- **An edit that removes a line removes it here.** A ghost line is revenue on a
  chart for a product the merchant never sold.
- **A line-less payload changes nothing** — neither the lines nor the
  truncation flag. This is the trap the flag introduced and the reason it is
  set in `upsertOrder` rather than in `rowData`.

## 4. Boundary

- **Lines are per shop.** α and β mirroring the same Shopify order id keep
  entirely separate rows; α's count is 0 before it writes its own and 1 after,
  while β's stays at 2. Asserted in both directions in the same test.
- **`OrderLine` is scoped automatically.** It carries a `shop` column, so the
  tenant extension picks it up from the DMMF with no registration step, and
  `tests/unit/scoped-models.test.ts` — which fails on any model that is neither
  scoped nor explicitly exempted — passes unchanged. The same is true of
  `resetDatabase`, whose table list is derived rather than maintained.

## 5. Invariants

1. **Every price comes from the engine.** Nothing in this table is a price this
   app produced. These are receipts — what Shopify charged — and the module
   imports the engine only for `money()` and `parseMoney`, never `resolvePrice`.
2. **Every query is shop-scoped.** The two new writes are inside the scoped
   client; §4 probes it.
3. **AI drafts; a person approves.** No AI path touches this.
4. **Nothing claims to have happened that did not.** This is most of the task:
   an unnamed discount is named as unnamed rather than dropped, a truncated
   line set is recorded rather than silently short, a line-less payload asserts
   nothing, and a negative line is clamped rather than charted.
5. **Deciding shows its working.** `discounts` carries the name the buyer was
   shown, which is what makes rule performance auditable at all.

## 6. Bugs found by this gate, and fixed

1. **The truncation flag misfired on line-less webhooks.** First written into
   `rowData`, where `lines: []` with a non-zero quantity reads as "incomplete" —
   so a fulfilment or cancellation webhook would have marked a perfectly
   mirrored order as truncated, and the analytics footer would have reported
   missing data on a store that had none. Moved into `upsertOrder`, where it is
   only trusted from a payload that actually carried lines.
2. **A typed fixture caught the schema change, as designed.** `OrderNode` is
   required-and-nullable rather than optional, so adding `lineItems` broke both
   fixtures in `tests/unit/orders-sync.test.ts` at compile time. Kept that way
   deliberately — the alternative is the 4.4 failure where an untyped customer
   fixture let a field migration change every synced buyer's email to null with
   no test failing.

## 8. What the cold read found, and what changed

Seven findings, all fixed. The three that changed the design are in
`docs/adr/0024` (addendum); the evidence and 16 reproducible probes are in
`qa/6.1/COLD-READ.md` and `qa/6.1/probes/`.

1. **Revenue was over-reported after any refund or order edit.** `quantity`
   and both line totals are Shopify's *pre-return* figures, while the parent
   `Order` row is written from `current_*` — so lines and order disagreed, and
   a fully refunded line stayed on every product and rule chart. `OrderLine`
   now carries `currentQuantity` and an apportioned `currentTotal` (rounded
   down), and the charts read the latter.
2. **`linesTruncated` could never be true through the webhook door** — both
   sides of the comparison were summed from the same array — and a webhook
   cleared a flag the backfill had set correctly on a 150-line order. Now
   `pageInfo.hasNextPage` through the GraphQL door and the payload sitting on
   the webhook's own line cap through the other. Every previous test for it
   passed by hand-injecting a `totalQuantity` neither door can produce.
3. **The query was ~100× over Shopify's 1,000-point cost ceiling.** Every page
   of the backfill would have been rejected, and every retry, leaving an empty
   Orders page. Now 10 orders × 50 lines, with the arithmetic written beside
   the constants.
4. **A money string that would not parse became zero, silently.** Shopify sends
   `"5000.00"` for JPY, which the strict parser rejects; a ¥5,000 line was
   mirrored as ¥0 with no log. `parseShopifyMoney` trims insignificant trailing
   zeros at the boundary and logs anything it still cannot read.
5. `line_items[].total_discount` was ignored, so an accepted quote's own
   discount mirrored as full-price revenue.
6. The "both doors agree" test used `10.00 × 10` — the one fixture shape where
   a multiplying reader and a reading one cannot disagree. Now `3.33 × 7`.
7. `createMany` had no `skipDuplicates`, so a repeated line item id rolled the
   whole order back and 500'd a webhook Shopify then redelivers.

Plus one the review noted last: `model AiRun`'s doc comment — including its
"no prompt or completion is stored" privacy note — had been left attached to
`OrderLine` in the DMMF by where the new model was inserted. Reattached.

**Confirmed sound by the review, not merely claimed:** tenant isolation fails
closed on read, update and delete by raw id; `createMany` is stamped by the
extension itself and rejects cross-tenant data; the scope survives into the
interactive transaction; DMMF pickup needs no registration for either
`resetDatabase` or the scope extension; invariant 1 holds; and there is no
concurrency or transaction-timeout problem — 2-way and 5-way concurrent
deliveries all succeed, and a 100-line write takes about 20ms.

## 7. Open, not passed

- **The query is schema-valid and now within the cost ceiling, but has never
  run.** Validated against Shopify's own schema (VALID; scopes `read_orders`,
  `read_products`, both already granted), and the cost arithmetic is done by
  hand from Shopify's documented model rather than measured — the response
  carries the real `throttleStatus`, and nothing here has ever seen one. No
  real order has ever been mirrored from a real store, the same limitation
  every Admin API call in this app has carried since 1.2.
- **The Function's discount message has never been read back off a real
  order.** Rule performance rests on Shopify reporting `message` as the
  discount application's title. That is documented behaviour and the query for
  it validates, but the round trip — Function writes a name, checkout applies
  it, webhook returns it — needs a real checkout, which this environment
  cannot do.
- **The line cap has never been hit for real.** `linesTruncated` is asserted
  from `hasNextPage` and from a payload built at the webhook cap, not from an
  order with 51 SKUs on a real store.
- **`currentTotal` is an apportionment, not a figure Shopify gives.** Shopify
  exposes no post-refund line total. A line refunded in part is therefore
  attributed pro-rata across its products and rules, which is a choice; the
  order-level revenue chart uses the order's own `totalPrice - refundedAmount`
  and needs no apportionment.
- **An install predating this change keeps line-less orders** until its
  backfill is re-run. No such install exists — this app has never been deployed
  to a real store — which is the only reason that is a note in `docs/adr/0024`
  rather than a migration.

# QA — 6.1 Mirroring order lines

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

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

## 7. Open, not passed

- **No cold read yet.**
- **The query is schema-valid but has never run.** Validated against Shopify's
  own schema through the AI Toolkit's validator (VALID; scopes `read_orders`,
  `read_products`, both already granted). No real order has ever been mirrored
  from a real store — the same limitation every Admin API call in this app has
  carried since 1.2.
- **The Function's discount message has never been read back off a real
  order.** Rule performance rests on Shopify reporting `message` as the
  discount application's title. That is documented behaviour and the query for
  it validates, but the round trip — Function writes a name, checkout applies
  it, webhook returns it — needs a real checkout, which this environment
  cannot do.
- **The hundred-line cap has never been hit.** `linesTruncated` is asserted
  from constructed facts, not from an order with 101 SKUs.
- **An install predating this change keeps line-less orders** until its
  backfill is re-run. No such install exists — this app has never been deployed
  to a real store — which is the only reason that is a note in `docs/adr/0024`
  rather than a migration.

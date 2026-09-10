# Cold read — 6.1 Mirroring order lines

Independent adversarial review of commit `1c2cafb` on `claude/mannon-b2b-wholesale-oc5b18`.
Reviewer did not write the code. Date: 2026-09-10.

## Verdict: **FAIL**

Two of the properties the task exists to guarantee do not hold, and a third is
very likely to stop the feature working on a real store:

- **The mirror over-reports revenue** for any order that was refunded or edited
  (F1). ADR 0024's headline promise — "no revenue on a chart for a product the
  merchant never sold" — is not delivered by delete-then-create, because a
  removed line does not leave the payload; it stays at its original quantity.
- **`linesTruncated` cannot be `true` for any order mirrored from a webhook**,
  and a webhook clears the flag on an order the backfill correctly flagged
  (F2). Invariant 4: 6.2 already turns this column into a merchant-facing
  "N orders incomplete" count, which will read 0 on a store that is missing
  lines.
- **The new query is roughly 100× over Shopify's maximum query cost** (F3), so
  the backfill — the only path that brings historical lines — most likely
  cannot run at all. "Schema-valid" does not mean "runnable".

Everything about tenant isolation, the transaction, and invariant 1 checks out;
those claims in `qa/6.1/REPORT.md` are confirmed below.

## What I ran

| Check                                                                                             | Result                                    |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `npx tsc --noEmit`                                                                                  | clean                                     |
| `npm run lint`                                                                                      | clean (0 warnings)                        |
| `npx vitest run tests/unit/order-lines tests/integration/order-lines tests/unit/orders-sync`         | 45 passed                                 |
| `npx vitest run tests/integration/{orders,webhooks,tenant-isolation,jobs} tests/unit/{scoped-models,webhook-registry}` | 101 passed          |
| 16 new probes (`qa/6.1/probes/` (drop the `.txt` to replay))                                                                    | all pass — i.e. all defects below reproduce |

Whole-suite run was deliberately not attempted (shared test DB, per instruction).
Note the working tree carries uncommitted 6.2 work (`app/lib/analytics/*`,
`shop_facts` migration); the 6.1 files are unmodified since `1c2cafb`.

### Reproducing the probes

They live outside vitest's include globs so they cannot rot into the suite.
To run:

```bash
cp qa/6.1/probes/unit-probes.test.ts        tests/unit/zz-probe.test.ts
cp qa/6.1/probes/integration-probes.test.ts tests/integration/zz-probe.test.ts
npx vitest run tests/unit/zz-probe.test.ts tests/integration/zz-probe.test.ts
rm tests/unit/zz-probe.test.ts tests/integration/zz-probe.test.ts
```

Every probe asserts **current** behaviour, so a probe that starts failing after
a fix is the fix working.

---

## Findings, ranked by what hurts a merchant

### F1 — HIGH — Refunded and edited-away units stay in the mirror at full price

**Where:** `app/lib/orders/sync.server.ts:163` (`linesFromNode`, `readQuantity(node.quantity)`),
`:168` (`originalTotalSet`), `:185` (`discountedTotalSet`), `:318` (`linesFromWebhook`,
`readQuantity(line.quantity)`); `app/lib/orders/admin-graphql.server.ts:74`
(`quantity` requested, `currentQuantity` not); `prisma/schema.prisma` `OrderLine`
(no current/refunded quantity column).

**What breaks.** Every money and quantity field the two readers use is defined by
Shopify as *before returns and removals*:

- GraphQL `LineItem.quantity` — "the number of units ordered"; `currentQuantity`
  is the one defined as "excluding refunded **and removed** units". The query
  never asks for it.
- `originalTotalSet` / `discountedTotalSet` — the line before/after discounts,
  **before returns**.
- REST `line_items[].quantity` vs `current_quantity` — same split; the reader
  ignores `current_quantity` (it is not even in the `WebhookLine` interface,
  `:286-299`).

Meanwhile the parent `Order` row is written from `current_*` figures
(`:237-240`, `:436-440`). So after a partial refund or an order edit the mirror
disagrees with itself: `sum(OrderLine.discountedTotal) > Order.subtotalPrice`,
and `sum(OrderLine.quantity) > Order.totalQuantity`.

**Concrete scenario.** Buyer orders 5 × Blue Mug at 10.00 = 50.00. Merchant
edits the order in Shopify and removes the line (`orderEditSetQuantity` → 0), or
refunds all 5. `orders/updated` arrives; the line is still in `line_items` with
`quantity: 5`, `current_quantity: 0`, `price: "10.00"`. `replaceLines` deletes
and rewrites it — as 5 units and 5000 minor units of revenue. Order total shows
0.00; the mirror's lines still show 50.00.

**Why it matters now:** `app/lib/analytics/charts.server.ts:286-298` (`topProducts`)
and `:320-345` (`rulePerformance`) — already written in the uncommitted 6.2 work —
sum exactly `line.discountedTotal` as product and rule revenue. The chart will
credit a product and a pricing rule with money that was returned. That is the
failure ADR 0024 opens with, still present: **delete-then-create only helps when
the line disappears from the payload, and for an order edit it does not.**

**Evidence:** probe `P2` (both doors), plus the field definitions above. Neither
ADR 0024 nor `qa/6.1/REPORT.md` mentions refunds anywhere — the word does not
appear in either document's treatment of lines.

**Fix direction:** request `currentQuantity` and store it (plus a refunded/
removed money figure, or at minimum recompute `discountedTotal * currentQuantity
/ quantity` at read time, which is a computation and therefore worse). For the
webhook door, `current_quantity` is already in the payload.

---

### F2 — HIGH — `linesTruncated` is structurally incapable of being true for a webhook, and a webhook clears a true flag

**Where:** `app/lib/orders/sync.server.ts:217-221` (`linesTruncated`), `:442-445`
(`factsFromWebhook` derives `totalQuantity` from `order.line_items`), `:534-543`
(`upsertOrder`).

**What breaks — direction 1 (truncated order reads complete).** For the webhook
door, `facts.totalQuantity` is the sum of the quantities of the *same array*
`linesFromWebhook` just read. `counted < totalQuantity` is therefore always
false (the only exception is a line with no id at all, filtered at `:455`).
Shopify caps order webhook payloads at 100 line items, so a 150-line order
arrives with 100 lines and `totalQuantity: 100`, and the flag says complete.
The comparison is against a number derived from the evidence it is supposed to
audit.

**Evidence:** probe `P1` — 100 webhook lines, `facts.totalQuantity === 100`,
`linesTruncated(facts) === false`. This holds *regardless* of whether Shopify's
100-line webhook cap is exactly 100; the flag can never fire from this door.

**Direction 2 (a correct flag is cleared).** `upsertOrder:536` writes
`linesTruncated` on every update whose payload carried lines. So: backfill
mirrors a 150-line order → `currentSubtotalLineItemsQuantity` 150 vs 100
counted → flag `true` (correct). The buyer's next `orders/updated` arrives →
flag recomputed from the webhook → `false`. The order is still missing 50 lines.
**Evidence:** probe `P11`.

**Direction 3 (node door, refunds).** `currentSubtotalLineItemsQuantity` is
post-refund while `counted` is pre-refund (F1). A 150-line order of qty 1 with
55 units refunded gives `counted = 100`, `totalQuantity = 95` → not flagged.

**Why it matters:** `charts.server.ts:158` counts
`db.order.count({ where: { …, linesTruncated: true } })` to tell the merchant
how much data is missing. It will report 0. Invariant 4 — "if a file was never
scanned, the badge says so" — the badge here says the opposite.

**Fix direction:** the honest signal is in the query, not in arithmetic: ask for
`lineItems(first: N) { pageInfo { hasNextPage } }` and store that, or compare
`nodes.length === LINE_PAGE_SIZE`. For the webhook door there is no honest
signal at all, so a webhook must **never lower** the flag — only raise it.
The three unit tests and two integration tests covering this
(`tests/unit/order-lines.test.ts:302`, `tests/integration/order-lines.test.ts:118-143`)
all pass a hand-written `totalQuantity: 400` into a fact object, which is the
one shape that can never arrive from either door.

---

### F3 — HIGH (unverifiable in this environment, one-sided arithmetic) — the orders query is ~100× over Shopify's maximum query cost

**Where:** `app/lib/orders/admin-graphql.server.ts:68` — `lineItems(first: 100)`
nested inside `orders(first: 100)` (`:13`, `:25`, used by `fetchOrderPage:207`).

**What breaks.** Shopify's calculated cost: object = 1, connection = 2 + `first`
× node cost. One `LineItem` node here costs ≈ 15 (node 1 + `product` 1 +
`variant` 1 + four MoneyBags × 2 = 8 + `discountAllocations` ≈ 4). So
`lineItems(first: 100)` ≈ 1,502 per order; one `Order` node ≈ 1,512;
`orders(first: 100)` ≈ **150,000 points**. The documented maximum cost of a
single query is 1,000 points (bucket maxima run 1k–20k by plan) — even a
*single* order with 100 lines (~1,500) exceeds the standard cap.

**Consequence.** Shopify returns `MAX_COST_EXCEEDED` in `errors[]`;
`fetchOrderPage:220` turns any `errors[]` into a thrown `Error`, so
`backfillOrders` (`app/lib/jobs/handlers/backfill-orders.server.ts:40`) fails on
every page, every retry. The merchant installs the app and the Orders page and
all six charts stay empty, with a job failing in the background. Note this also
means F1/F2's node-door behaviour has never been and cannot be exercised here.

**Evidence.** Arithmetic only — this environment has no egress and the repo
carries no Admin schema, so I could not reproduce it or check the author's
"validated → VALID" claim. That claim is about *schema validity*, which is a
different property from cost and does not cover this. Scopes are genuinely
granted (`shopify.app.toml:27`: `read_orders`, `read_products`) — that part of
the claim checks out.

**Fix direction.** Either drop the page sizes hard (orders 5–10 × lines 10 keeps
you near 1,000) and accept more round trips, or move the backfill to
`bulkOperationRunQuery`, which has no cost ceiling and would also delete the
100-line cap and F2's whole reason for existing.

---

### F4 — MEDIUM — an unparseable amount becomes a confident zero, silently

**Where:** `app/lib/orders/sync.server.ts:93-100` (`readMoney`'s bare `catch`),
`packages/pricing-engine/src/money.ts:83-90` (`parseMoney` throws when a decimal
string carries more precision than the currency allows), `money.ts:20-45`
(`JPY`, `KRW`, `CLP`, `VND`, `ISK`, … exponent 0).

**What breaks.** Shopify formats money with decimal places for every currency
("5000.00"), including zero-decimal ones. `parseMoney("5000.00", "JPY")` throws
`MoneyError`; `readMoney` swallows it and returns **0**, with no log, no flag and
no user-visible copy. On a JPY/KRW/VND store every mirrored line — and, because
`readMoney` is used for the order too (`:237-239`), every order total — is zero.
The Orders page shows a store with no revenue, and the charts agree.

**Evidence:** probe `P4` — `linesFromWebhook([{price:"5000.00", quantity:2}], "JPY")`
yields `unitPrice.amount === 0` and `originalTotal.amount === 0`.

Pre-existing in `readMoney` (not introduced by 6.1), but 6.1 multiplies the blast
radius from three order fields to every line, and 6.2 turns it into charts.
Regardless of the JPY specifics, "a parse failure becomes 0 with no warning"
violates invariant 4 on its own: 0 is a claim.

---

### F5 — MEDIUM — the webhook reader ignores `line_items[].total_discount`

**Where:** `app/lib/orders/sync.server.ts:322-338` and `:357` — the discounted
total is derived only from `discount_allocations`; `total_discount` is not in the
`WebhookLine` interface at all (`:286-299`).

**What breaks.** REST carries line-level discounts that did not come from a
discount *application* — most relevantly draft-order discounts, which this app
creates itself in the quotes flow — in `total_discount`, with
`discount_allocations` possibly empty. The line then mirrors at full price with
`discounts: []`: money that was given away is reported as revenue, and the quote
or rule that gave it away is invisible to `rulePerformance`. It also breaks the
one arithmetic invariant the ADR names ("a line's discounts add up to the
difference between its two totals") in the one place that difference is
*derived* rather than read.

**Evidence:** probe `P5` — a line with `price: "10.00"`, `quantity: 2`,
`total_discount: "5.00"`, `discount_allocations: []` mirrors as
`discountedTotal: 2000`, `discounts: []`.

Whether real draft-order webhooks populate allocations as well needs a real
store to settle. Either way the reader has no fallback, and adding
`total_discount` as one costs three lines.

---

### F6 — MEDIUM — "both doors agree" is asserted on exactly one fixture where they cannot disagree

**Where:** `tests/unit/order-lines.test.ts:257-270`.

The fixture is price 10.00 × quantity 10 = originalTotal 100.00, i.e. the one
case where `price × quantity` and Shopify's `originalTotalSet` are trivially
equal. The divergences the test cannot see are F4 (zero-decimal currencies zero
out through different code paths), F5 (`total_discount`), and any line where
Shopify's own line total is not exactly `price × quantity`. `REPORT.md` §3 claims
this property is "asserted field by field, because the payload's shape is the
awkward one" — the assertion is field-by-field, the *coverage* is one shape.

**Fix direction:** table-drive it over the awkward shapes (fractional allocation,
order-level allocation, zero-decimal currency, `total_discount`), and generate
the node fixture from the webhook fixture so a new field cannot be forgotten on
one side.

---

### F7 — MEDIUM/LOW — a unique-constraint collision on one line throws the whole order away

**Where:** `prisma/schema.prisma` `OrderLine` `@@unique([shop, lineItemId])`
(shop-wide, not per order) + `app/lib/orders/sync.server.ts:575` `createMany`
without `skipDuplicates`, inside the order's own `$transaction` (`:538`).

**What breaks.** Any P2002 raised while writing lines rolls back the order
upsert too, so the order is not mirrored *at all*, the webhook 500s, and Shopify
redelivers the same failing payload for two days. The order's own totals never
depended on the lines; losing the order because a line collided is the wrong
trade for a mirror.

**Evidence:** probe `P9`, both directions — (a) a payload with two lines sharing
an id ends with `order.count() === 0`; (b) a second order carrying a line id
already held in that shop throws and leaves the second order unmirrored.

Neither input is something Shopify normally sends, which is why this is not
HIGH. Reachability is the open question; the cost when it happens is total.

**Concurrency is fine, contrary to my prior:** probes `P10` (2-way) and `P12`
(5-way) run concurrent `upsertOrder` calls for the same order and all succeed
with a consistent final state — the order row lock taken by the upsert
serializes the line work behind it. And `P8`: a 100-line order writes in ~20ms
insert / ~17ms replace, nowhere near the 5s interactive-transaction budget. No
deadlock or timeout risk found.

---

### F8 — LOW — `model AiRun` lost its documentation to `OrderLine`

**Where:** `prisma/schema.prisma` ~line 1060. The new model was inserted between
AiRun's `///` doc block and `model AiRun`, so the block now documents
`OrderLine`.

**Evidence:**

```
$ node -e "…Prisma.dmmf.datamodel.models…"
### OrderLine -> "One call to Claude.\n\nOperational, not evidential: the audit log records what a merchant "
### AiRun    -> ""
```

The orphaned text is the one that states **no prompt and no completion are
stored** — a load-bearing privacy note now attached to the wrong table. Move the
block back above `model AiRun`.

---

### F9 — LOW — `OrderLine` stores money with no currency

Every amount is minor units with no `currencyCode` column, so correctness
depends on every reader joining through `Order.currencyCode`. §7 of the
checklist requires "currency = store currency"; a shop that has changed currency,
or any future reader that queries `orderLine` without filtering orders by
currency first, sums across currencies silently. Denormalise `currencyCode` onto
the row (as `Order` already does) or state the join requirement on the model.

---

### F10 — LOW — the one multiplication is the one unguarded number

`app/lib/orders/sync.server.ts:320` — `money(unitPrice.amount * quantity, …)`
throws `MoneyError` when the product is not a safe integer, and `readQuantity`
(`:102-105`) accepts any finite non-negative number. Probe `P3`: quantity `1e15`
at price 10.00 throws straight out of `factsFromWebhook`, which every other
malformed field is carefully written to survive (`readMoney`, `readDate`,
`readQuantity` all fail soft). Input is HMAC-signed so this is not an attack
path, but it contradicts the module's own contract.

---

### F11 — NIT — `sync.server.ts:279-280` uses Prisma-style `///` doc comments inside TypeScript, where the rest of the file uses `/** */`.

---

## Claims in `qa/6.1/REPORT.md` — verified or not

| Claim                                                                     | Verdict                                                                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `resetDatabase` picks up `OrderLine` from the DMMF, no registration step   | **TRUE** — `tests/support/db.ts:13` maps `Prisma.dmmf.datamodel.models`                                                       |
| The tenant extension scopes `OrderLine` automatically                      | **TRUE** — `shop-scope.server.ts:53-63` derives from DMMF; `createMany`/`deleteMany` are both covered (`:18-35`)              |
| `createMany` really gets the shop stamp                                    | **TRUE, and not only from the explicit `...tenant()` spread** — probe `P6` shows `createMany` with another shop's `shop` value raises `CrossTenantError` from the extension |
| Cross-tenant reach fails closed                                            | **TRUE** — probe `P6`: find-by-id → null, `updateMany`/`deleteMany` → count 0, no context → `MissingShopContextError`         |
| Tenant scope survives the interactive transaction                          | **TRUE** — probe `P7`: rows read with the raw client carry the right `shop`                                                    |
| The backfill now brings lines with it                                      | **TRUE structurally** (`backfill-orders.server.ts:45` → `factsFromNode` → `lines`) — but see F3, which may make it moot        |
| The GraphQL query is schema-valid (validated with Shopify's validator)     | **NOT VERIFIABLE HERE** — no Admin schema in the repo, no egress. Field-by-field it reads correct for 2025-07 and the required scopes are granted. Schema validity does not address F3. |
| Invariant 1 — nothing here computes a price                                | **TRUE** — only `money`/`parseMoney` imported from the engine, no `resolvePrice`; the values are Shopify's. The single multiplication is defensible in principle (the payload has no line total), with the caveats in F5/F6/F10 |
| Invariant 4 — "nothing claims to have happened that did not"               | **FALSE** — F1 (revenue that was refunded), F2 (a completeness flag that reads complete when it is not), F4 (a parse failure that reads as zero) |
| "17 unit / 8 integration, green"                                           | **TRUE** — re-ran: 45 tests across the three touched files, plus 101 in the adjacent suites. All green. The tests are green *and* the behaviour is wrong, which is F2's and F6's real lesson about their fixtures |

## Conventions

Clean: no `any`, `@ts-ignore`, `as never`, `.only`, skipped tests, `console.log`,
or commented-out code in the diff. `tsc --noEmit` and `eslint --max-warnings 0`
both pass. No client-side surface in this task, so no bundle/secret exposure and
no i18n keys to check. `replaceLines` adds no logging — which is right for the
happy path, and is part of why F4 and F7 would be invisible in production.

## What a re-run needs

1. Fix F1, F2, F3 — these are the verdict.
2. Then re-run from QA step 2, including probes `P1`, `P2`, `P4`, `P5`, `P9`,
   `P11`, each of which should *flip to failing* once the corresponding defect is
   fixed. Convert the ones that survive into real tests under `tests/`.
3. Delete `qa/6.1/probes/` (drop the `.txt` to replay) once its cases live in the suite.

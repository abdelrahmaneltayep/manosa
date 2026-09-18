# QA — the P4s

Date: 2026-09-19
Scope: every finding filed as **P4** across the thirteen cold reads in `qa/`,
and the rung below P3 that the request was reaching for.

---

## There is no P4 severity band

Worth stating plainly, because the last four rounds walked P0 → P1 → P2 → P3
and the ladder stops here. Two things in `qa/` carry the label "P4", and
neither is a P4-severity finding:

| Where | What it actually is | State |
| --- | --- | --- |
| `qa/5.3/COLD-READ.md:160` | Finding **P4** of a `P1`–`P17` list whose severity is the word beside it (**MEDIUM**): *"The publish/save/review action has no plan gate at all."* | **Closed.** `app.storefront-agent._index.tsx` checks `hasFeature(entitlements, "buyer_agent")` before every intent, and `log.$id.tsx` gates `takeOver` and `replyAsMerchant` the same way. |
| `qa/6.1/COLD-READ.md:204` | A **reproduction probe** named `P4`, cited as evidence for finding **F4**. Not a finding. | **Closed.** `parseShopifyMoney` trims the insignificant zeros Shopify sends for zero-decimal currencies, and logs anything it still cannot read instead of returning a silent zero. |

The four cold reads that use numbered severity bands (6.2, 6.3, 6.4, 6.5) stop
at P3, which the previous round closed. So the honest answer to "fix the P4s"
is that there are none — and the honest continuation is the rung below P3 in
the one cold read that ranks by HIGH / MEDIUM / LOW / NIT.

## The rung below P3

`qa/5.3` (P8–P17, LOW and NIT) and `qa/6.1` (F8–F11, LOW and NIT) are that
rung. All ten of 5.3's were re-derived from the source and are genuinely
closed — the capture guard now derives `CATALOG_ROOTS` from the catalogue
itself rather than a hand-kept list, `takeOver` claims with a conditional
`updateMany` and announces only when it won, the outcome goes through
`recordOutcome`, the reply has a `maxLength` and a rejection, `published` is
out of `saveGuardrails`, the export is bounded and honours the toolbar's
filters, the rehearsal picker paginates and reports a buyer it could not find,
the dead view data is gone, refusal codes go through the catalogue, and the
attestation writes its own audit entry while `agent.published` records which
four items were true.

**Three of 6.1's four were not.**

---

## 6.1 F9 — `OrderLine` stored money with no currency

**The finding.** Every amount is minor units with no `currencyCode` column, so
correctness depends on every reader joining through `Order.currencyCode`. The
cold read offered two fixes: denormalise the column, **or** state the join
requirement on the model.

**Why the second one was not enough.** It was already done — the model header
says *"Shopify's numbers, in minor units of the order's currency"* — and the
reviewer read that line and filed the finding anyway. A comment is not a guard.
Both readers today (`charts.server.ts`, `review.server.ts`) pass an order-id
list that was filtered by currency upstream, so the table is correct right now;
the risk is entirely the next reader, and a prose note is what that reader will
not have read.

**The fix.** `OrderLine.currencyCode`, migration
`20260919090000_order_line_currency`, backfilled from the parent order.

Two details that matter more than the column:

- The `DEFAULT ''` needed to add a `NOT NULL` column to a populated table is
  **dropped in the same migration**. Leaving it would let a future insert write
  an empty currency, which is the same silence in a new place.
- The writer takes the currency from `line.unitPrice.currencyCode` — the
  currency the amounts were actually parsed in — rather than copying the order
  row. If those two ever disagree, the copy would hide it and this does not.

**Probes** (`tests/integration/orders.test.ts`, +2): a JPY webhook writes `JPY`
on the line (and its zero-decimal amount survives as ¥5,000, not the confident
zero it used to be); a two-line order has both lines agreeing with the order.
**Reverted** (writer hard-codes `"XXX"`): both failed — `expected 'XXX' to be
'JPY'` and `Beans: expected 'XXX' to be 'USD'`.

The type change also found two fixtures that built `OrderLine` rows by hand,
including the reviewer's own probe file — which is the column doing its job
before it ever reached a database.

## 6.1 F10 — the one multiplication was the one unguarded number

**The finding.** `money(unitPrice.amount * quantity, …)` throws `MoneyError`
when the product is not a safe integer, and `readQuantity` accepts any finite
non-negative number. A quantity of `1e15` at $10.00 threw straight out of
`factsFromWebhook` — the one function here written so that every malformed
field fails soft.

**Why it is worth fixing despite the HMAC.** The input is signed, so this is
not an attack path. But a webhook that throws is an order that never mirrors,
and Shopify redelivers it to fail the same way: the failure mode is a
permanently missing order, not a rejected request.

**The fix.** `lineTotal(unitPrice, quantity, context)` in `app/lib/money.ts`,
beside `parseShopifyMoney` and striking the same bargain — nothing invented,
the operator told what could not be read, and the caller handed a zero it can
see rather than an exception it cannot.

**Probe** (`tests/unit/order-lines.test.ts`, +1): `1e15 × $10.00` returns
`0 USD`, keeps the unit price, and logs once with the reason.
**Reverted:** `Money must be whole minor units, got 1000000000000000000 USD`
thrown out of the reader.

## 6.1 F11 — Prisma-style `///` comments inside TypeScript

**The finding.** `sync.server.ts` used `///` where the rest of the file uses
`/** */`. In TypeScript `///` is a triple-slash *directive* at the top of a
file and an ordinary line comment anywhere else — no tooling reads it as a doc
comment, so the text does not reach a hover or a signature.

**The fix, wider than the finding.** Grepping the whole tree found 14 more in
`app/lib/jobs/registry.ts` — including three I wrote in earlier rounds of this
very sequence. All converted; `grep -rn "^\s*///"` over `app`, `packages`,
`extensions` and `tests` now returns nothing, which is the check that keeps it
from coming back one file at a time.

---

## Invariants

1. **Every price from the engine** — held. `lineTotal` mirrors Shopify's own
   arithmetic for a webhook payload that carries no line total; it decides no
   price and the schema comment has always said so.
2. **Shop scoping** — `OrderLine` gains a column, not a query path; the
   migration's backfill joins on `shop` as well as `orderId`, and
   `tests/integration/tenant-relations.test.ts` still probes the model.
3. **AI drafts, a person approves** — untouched.
4. **Nothing claims to have happened that did not** — F9 and F10 are both
   this: a total summed across currencies, and an order that silently never
   arrived.
5. **Deciding shows its working** — unchanged.

## Suite

`npx vitest run` — **140 files, 2487 tests, all passing.**
`npm run lint` clean, `npx tsc --noEmit` clean, `npx prettier --check .` clean.

## What this round does not prove

**The backfill ran against an empty table.** `mannon_test` and `mannon_dev`
hold no production orders, so the `UPDATE … FROM "Order"` in the migration is
verified by reading it and by the column being `NOT NULL` with no default
afterwards — not by watching it rewrite real rows.

**`lineTotal`'s guard is reachable only through a payload no real store sends.**
Shopify will not send `quantity: 1e15`. The probe constructs it, which is the
point — the contract is that the reader survives anything, and nothing else
tested that it did.

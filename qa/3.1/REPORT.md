# QA report — 3.1 · Wholesale order list, order limits, quantity increments

Reviewed as someone who did not write it and does not trust it.

### 1. Test plan

The spec: checklist §5's "Wholesale orders list" and "Order limits" blocks, and
the phase plan's "order webhooks, placed-via attribution, order limits (+
storefront enforcement messages), quantity increments". Net payment terms are
3.2 — the `netTermsDueAt` column exists and the list already renders the states
that depend on it, but nothing fills it in yet.

Happy paths: an approved buyer checks out and the order appears in the list with
the right chip; the merchant sets a $200 minimum on a tier and a buyer under it
is told the gap; a refund lands and the row reflects it; a merchant edits an
order in Shopify and the row says the total is stale.

Invented abuse cases:

1. **Malformed input.** An order webhook with no id; a total that is not a
   number; every optional field missing; a `source_name` we have never seen; an
   `orders/edited` payload with no `order_edit`; a typed amount that is not a
   decimal; a case size of 0.
2. **Concurrent edits.** Two staff saving a limit for the same group at the same
   moment; the same order webhook delivered twice at once.
3. **Wrong tenant.** Reading, deleting and resyncing another shop's order and
   another shop's limit, by id.

### 2. Automated tests

`npm test` — **908 tests, 48 files, all passing** (853 at 2.3). New:

- `tests/unit/orders-sync.test.ts` (20) — both wire shapes narrowed to the same
  facts, source classification from the note attribute and from `sourceName`,
  refunds summed from transactions rather than assumed, and every "Shopify sent
  nothing" branch.
- `tests/integration/orders.test.ts` (38) — the three order webhooks against a
  real database, the tag written once and not on redelivery, the backfill's
  paging, the overdue-first sort, filters, pagination across both sort bands,
  the limits CRUD with its publish, the plan gate, two concurrency cases and
  three tenant-boundary cases.
- `tests/unit/orders-pages-states.test.tsx` (20) — every state below.
- `packages/order-limits` (45) and `extensions/mannon-limits` (15), written
  earlier in this task, run in the same suite.

`npx playwright test` — **177 passing** (159 at 2.3).

Lint, `tsc --noEmit`, `npm run build` and `prettier --check` are clean.

### 3. State walkthrough

19 states captured to `qa/3.1/`. Orders: empty, first sync with skeletons, rows
with all four placed-via chips and a partial refund, edited-in-Shopify,
cancelled, filtered to nothing, paginated, Arabic. Limits: empty with worked
examples, limits in force, the buyer preview, not-yet-published, a min-above-max
conflict, a case size that does not divide the minimum, plan-gated, editing,
Arabic.

Read as screenshots, not only asserted. Two things came out of looking:
`limits.publishedAt` was rendering a raw ISO chunk (`2026-09-10T09:00`), now a
date; and the limits table read as four columns of numbers, so each row now
carries a sentence ("$200.00 minimum · cases of 12") — a merchant reading their
own limits back is checking they mean what they intended.

### 4. Cross-tenant check

Three cases, all holding: one shop's orders never appear in another's list and
`findFirst` by Shopify order id returns null across the boundary; a webhook
running in one shop's scope writes nothing into another's mirror;
`markNeedsResync` for another shop's order flags zero rows. Deleting another
shop's limit is refused with 404 **before any Admin API call**. `Order` and
`OrderLimit` both carry `shop`, so the DMMF-driven guard picks them up with no
registration step.

### 5. The invariants

| Rule                                           | Status at 3.1                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every price comes from the pricing engine      | Held. Nothing here computes a price: order totals are Shopify's own numbers, and limits compare a subtotal without ever producing one. All money is `Money` from the engine, formatted by its formatters. |
| Every query is shop-scoped                     | Held, and probed above.                                                                                                                                                                            |
| AI drafts, a person approves                   | Held, and nothing here is AI. The ✦ Buyer Agent chip is a source label on an order the buyer placed themselves.                                                                                     |
| Nothing claims to have happened that did not   | Three places this bit: the 60-day note on the list, the resync badge, and the "these limits haven't reached Shopify yet" warning. All three exist because the alternative was a page that implied otherwise. |
| No unhandled promise rejections in the e2e run | Clean.                                                                                                                                                                                             |

### 6. Bugs found and fixed

1. **The shop metafield would have been written to nothing.** `publishLimits`
   built its `ownerId` as `gid://shopify/Shop/${record.id}` — our own Prisma
   cuid, not Shopify's numeric shop id. Every limit publish would have failed,
   or worse, succeeded against a resource nobody reads. The GID is now read once
   from `shop { id }` and cached on the Shop row, and the integration test
   asserts the exact `ownerId` that goes on the wire.

2. **Every order without net terms vanished from page 2.** The orders list is
   two sort bands — overdue first, then everything else — and the second band
   was expressed as `NOT { paidAt: null, cancelledAt: null, netTermsDueAt: { lt:
   now } }`. In SQL a NULL due date makes that comparison unknown, so the whole
   `NOT` is unknown and the row matches neither band. Since nothing fills in
   `netTermsDueAt` until 3.2, that is *every order in the list*. Caught by the
   pagination test, which is the only one that reaches the second band. The
   complement is now spelled out as an explicit `OR`.

3. **The resync badge could never appear.** `needsResync` was a column with no
   writer: `upsertOrder` sets it false and nothing set it true. Found by
   grepping for callers of `markNeedsResync` and finding only tests. The right
   trigger turned out to be a webhook I had not subscribed to — `orders/edited`,
   whose payload is a line-item diff with no totals in it. It now flags the row,
   and the `orders/updated` that follows the edit clears it.

4. **`increment_below_two` broke the Arabic catalogs.** A machine-readable code
   ending in `_two` is read by i18next as a plural suffix, so the catalog test
   demanded `increment_below_zero`, `_one`, `_few`… Renamed to
   `increment_too_small` at the source rather than worked around in the
   catalogs.

5. **`write_orders` was missing from the scopes.** Tagging an order needs it and
   the manifest asked only for `read_orders`, so the tag would have failed on
   every wholesale order — silently, since tagging is deliberately non-fatal.

Two more were dead code rather than defects: `getLimit` and `fetchOrder` were
written and never called, and are gone.

### 7. Open items

- **Still not seen in a real Shopify admin**, now across five phases.
- **The validation Function has never run at a real checkout.** Its 15 tests
  drive `run()` directly against hand-written input fixtures. Whether Shopify's
  `purchase.validation.run` input matches those fixtures — in particular whether
  the app-reserved buyer metafield is readable from that target — is unverified
  without a store. The Function is written to return no errors on anything it
  cannot read, so the failure mode is "the limit does not apply", never "the
  store cannot check out".
- **Nothing fills in `netTermsDueAt`.** Every payment state that depends on it —
  due, overdue, the overdue-first sort — is implemented and tested against
  seeded rows, but no order will have a due date until 3.2.
- **The buyer's limit message is English only.** `DEFAULT_MESSAGES` ships one
  language, and Settings § 6.2 is where the templates become editable. The
  Function has no ICU, so money there reads "USD 38.00" while the admin shows
  "$38.00" — see `app/lib/money.ts` for why that is the honest split.
- **Placed-via is only as good as the note attribute.** Shopify reports every
  app extension's cart as the storefront, so quick-order and Buyer-Agent
  attribution depend on `_mannon_source` being set by surfaces that do not exist
  yet (3.4 and 5). Until then every real order reads as Storefront, Draft or POS,
  which is true.
- **The 60-day window.** The list says so on the page; `read_all_orders` is a
  review-time grant and not one to request for a feature nobody has asked for.
- **`Order` rows are never pruned.** Retention lands in 7.2, with the rest.

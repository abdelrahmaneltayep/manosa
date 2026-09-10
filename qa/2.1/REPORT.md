# QA report — 2.1 · Customer sync, groups, tagging engine, buyers list


Reviewed as someone who did not write it and does not trust it.

### 1. Test plan

The spec: checklist §3 (pending approvals, approved-buyers list, customer
groups, ✦ segment builder) and pages-features §3. Pending approvals and the
approve/reject flows belong to 2.3, and the segment builder to 4.3; this task
owns the sync that everything else reads, the groups, the tagging engine, and
the buyers list with its states.

Happy paths: an install backfills an existing customer base; a webhook keeps
one buyer current; a merchant creates the starter tiers, moves a buyer between
them, edits tags, writes a note, marks someone tax-exempt; a tagging rule is
previewed and applied.

Invented abuse cases:

1. **Malformed input.** A `customers/update` payload with `total_spent: "not a
number"`, no id at all, or tags as a comma string with duplicate whitespace.
   A stored tag condition with an unknown operator, an unknown field, a string
   where an object belongs, and a country condition with an empty list.
2. **Concurrency.** The backfill and a webhook writing the same customer at the
   same instant. This is not hypothetical — the backfill pages through the whole
   store while webhooks keep arriving.
3. **Wrong shop.** Reading, moving, deleting and sweeping another shop's
   customers and groups by id; a webhook delivery for shop B landing while shop
   A's data is in scope.

### 2. Automated tests

`npm test` — **564 tests, 32 files, all passing** (451 at 1.4). New:

- `tests/unit/tagging.test.ts` (31) — the pure engine: every condition kind,
  currency refusal, the never-ordered case, priority ordering and its tie-break,
  determinism, non-mutation, defensive parsing, validation, and a purity check
  that reads the source and fails on a clock or a foreign import.
- `tests/integration/customers.test.ts` (45) — narrowing both payload shapes,
  idempotent upserts, the concurrency case, backfill paging and resumption,
  group CRUD with the delete guard, list filters and pagination, the four row
  actions, the plan gate, preview-equals-apply, and eight tenant-isolation
  cases.
- `tests/unit/customers-pages-states.test.tsx` (33) — every state below.
- `tests/unit/pricing-pages-states.test.tsx` (+3) — regressions for the two
  1.3 defects found here.

Playwright: **89 passing**, including 31 screenshots of the 2.1 captures.

Lint, `tsc --noEmit`, `npm run build` and `prettier --check` are clean.

### 3. State walkthrough

31 states rendered and captured to `qa/2.1/` (HTML + PNG). Buyers list: empty,
first sync with skeletons, syncing with rows already in, ideal, badges (at
risk / pending / tax-exempt / deleted in Shopify), no results, orphaned buyers,
stale, paginated, AI-not-ready. Groups: empty with starter tiers, ideal with a
tier flagged as having no pricing, the delete guard, duplicate handle, the
bundle page, the empty bundle, and a paginated member list. Buyer page: ideal,
unverified VAT, VAT required, deleted in Shopify. Auto-tagging: empty, locked,
ideal, preview, preview with nothing to do, a run with failures, a rule held
back for an unreadable condition, validation. Arabic: the buyers list and the
groups page, RTL, with the dual form checked.

The captures are structure only — no egress to Shopify's CDN, so `s-*` elements
never upgrade. Each capture says so at the top. Three of the bugs below were
found by looking at them.

### 4. Cross-tenant check

Eight cases, all holding: another shop's customer and group both read as
not found; deleting their group is refused with 404 and leaves it intact;
moving their customer into one of my groups is refused _before_ any Shopify
call is made; a webhook for shop B writes nothing into shop A; a tag sweep
examines only the shop it is scoped to. `Customer`, `CustomerGroup` and
`CustomerTagRule` all carry `shop`, so the scope guard picks them up from the
DMMF without a registration step.

### 5. The three musts

| Rule                                           | Status at 2.1                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | Held. The only money on these screens is Shopify's own lifetime total for a buyer, formatted with the engine's `formatMoney`. It is a historical fact, not a price this app computed. |
| No AI mutation without an approval record      | Held, and nothing here is AI. The ✦ segment builder is rendered disabled and the reorder-prediction chip is never emitted, because neither model exists yet.                          |
| No unhandled promise rejections in the e2e run | Clean. The only stack trace in the server log is the deliberate 404 test.                                                                                                             |

### 6. Bugs found and fixed

1. **`disabled={!view.aiAvailable}` would have killed the ✦ button the day the
   AI layer shipped.** React stringifies props on custom elements, so
   `disabled={false}` renders `disabled="false"` — and a browser reads any value
   as the attribute being set. The button reads correctly today only because
   `aiAvailable` is false. This is the exact bug 1.3 wrote a `whenDisabled`
   helper for, missed in the same file that defined the helper. The helper now
   lives in `app/components/boolean-attribute.ts` with `whenChecked` and
   `whenLoading` beside it, and a test asserts no `disabled="false"` reaches the
   markup — verified by reverting the fix and watching it fail.

2. **The combinations checkbox showed ticked on a rule that does not combine.**
   Same cause, live rather than latent: `checked={form.combinable}` renders
   `checked="false"`, so every non-combinable rule opened in the builder claimed
   it stacked with other discounts. On a control that decides whether two
   discounts apply to the same line. Found by grepping for the pattern behind
   bug 1 rather than by any test; now covered by one.

3. **Two columns headed "Group" in the buyers table.** Found by looking at
   `05-buyers-badges.png`. The row action column reused the same catalog key as
   the group column; it now reads "Change group".

4. **A deleted buyer's row promised a future price.** Also from the same
   capture: "New prices apply on this buyer's next visit to your store" rendered
   on a row marked deleted in Shopify, where no price applies at all.

5. **The group page showed the first fifty members and nothing else.** No
   pagination, in a codebase whose rule is that every list paginates. A tier
   with three hundred members would have looked like it had lost two hundred.

A sixth was in a test, not the code: the search test asserted that "gold" should
not match a company called "Goldsmith & Co". It should — company is a substring
search, and a merchant typing "gold" wants it. The property actually worth
holding is that a _tag_ match is whole, so "gold" does not return every buyer
tagged `goldsmith-only`; the test now says that instead.

### 7. Open items

- **Not seen in a real Shopify admin.** Unchanged from 1.2–1.4 and now spanning
  two phases. `shopify.dev` and `cdn.shopify.com` are blocked by org policy, so
  Polaris never upgrades and the embedded surfaces cannot be driven. Everything
  above is asserted markup, not a merchant's screen.
- **The Admin API calls are pinned, not exercised.** `tagsAdd`, `tagsRemove`,
  `customerUpdate(taxExempt)` and the customers query are asserted by the exact
  query and variables sent, against a fake. Their real behaviour — field names,
  the `numberOfOrders` string, whether `defaultAddress` is null for a customer
  with no address — is unverified without a store. The mapping is defensive
  about all three.
- **Shopify B2B companies are not modelled.** Pages-features §3 lists companies,
  locations and catalogs on Plus. Groups are Mannon's own tiers; the two need to
  be reconciled, which needs a Plus store to look at.
- **Approval status is a column with no pipeline.** `BuyerStatus` exists and the
  list renders PENDING and REJECTED, but nothing sets them until the approval
  pipeline lands in 2.3. Every synced customer is APPROVED, which is true —
  they can already place orders.
- **Auto-tagging has no schedule.** By decision, not omission — see ADR 0011.
  The merchant presses apply. A sweep that re-prices a customer base with nobody
  watching should not exist before the reporting to explain it does.
- **The tag rule builder takes one condition.** The engine handles many, `all`
  and `any`, and seven condition kinds; the form offers one condition of four
  kinds. The full editor is worth doing next to the ✦ segment builder in 4.3,
  which needs the same control.
- **`vatNumber` has no way in yet.** The column and the tax-exempt guard that
  reads it are here; the registration form that collects it and the VIES check
  that verifies it are 2.2.
- **At risk is a fixed 60 days**, not a per-customer cadence. Deliberate: a
  merchant has to be able to read the badge and know what it claims. The
  prediction version arrives with the AI layer and will be labelled as one.

# QA — the five billing P0s from `qa/0.3/COLD-READ.md`

**Date:** 2026-09-18
**Scope:** the five P0s the 0.3 cold read raised, plus P1-1, which the honesty
of P0-2 depends on.
**Verdict:** all five fixed, each verified against the reviewer's own probe by
reverting the fix and watching the probe fail for its stated reason.

## What was wrong, and what now happens

### P0-1 · CSV import was not gated anywhere

`assertFeature("csv_import")` appeared nowhere in the codebase. A Free shop
could download every rule it had (`?download=export`, page size 5000), upload a
file, have **Claude propose the column mapping on the app owner's key**, and
import. It was not even a disabled button: the link rendered on every plan.

**Fixed** at three layers, in the order that matters:

1. `runImport` refuses — the service layer, which is the enforcement a
   hand-crafted request still meets.
2. The route's **action** refuses before anything is parsed, mapped or sent to
   Claude. `runImport` alone would already have read the upload and spent the
   model call.
3. The route's **loader** refuses, which covers the two downloads, and the link
   points at `/app/plans?from=import` when the plan does not include it.

Note for whoever changes the ladder: the batch row-quota check inside
`runImport` is now unreachable through any real plan, because every tier that
includes CSV import also removes the rules quota. It is kept as defence against
a ladder that does not, and the test says so rather than pretending to exercise
it.

### P0-2 · Nothing paused when a subscription lapsed

`entitlementsFor` correctly dropped `effectivePlan` to Free, and the gate
correctly refused every **admin** action. But three capabilities reach a buyer
through a metafield Shopify evaluates without asking us:

| Capability     | Read by                        | What kept happening after a lapse                 |
| -------------- | ------------------------------ | ------------------------------------------------- |
| Pricing rules  | the discount Function          | every rule over quota kept pricing, for ever      |
| Order limits   | the validation Function        | every minimum kept blocking buyers' carts         |
| Net terms      | the payment customization      | buyers kept being offered "pay in 30 days"        |

The last one is the worst shape: the app went on **extending credit** while
`recordPayment` threw `FeatureLockedError`, so the merchant could no longer
record the money coming in against invoices this app was still issuing. The
credit half ran and the collection half stopped.

And the Plans page said the opposite in the merchant's own language —
"they stay saved and **stop applying** until you move back up", "Paid features
are paused". Invariant 4, on the page that takes the money.

**Fixed in two halves**, because either alone is useless:

- **Each publisher now asks what the effective plan allows.**
  `activeEngineRules` — the single read behind the ruleset publish, quotes,
  PO-to-order, quick order and the Buyer Agent — truncates to the quota, in the
  cascade's own priority order, so which rules survive is something a merchant
  can predict and audit rather than a coin toss. `publishLimits` publishes an
  empty set. `publishBuyerTerms` publishes `terms: null`.
- **`billing.reconcile` runs them at the moment the answer changes**, queued by
  both plan writers (the Shopify sync and the `app_subscriptions/update`
  webhook), in both directions — a downgrade withdraws, resubscribing puts
  everything back. Buyers are paged with a cursor on the shop row, like the
  backfills.

**Nothing is deleted at any point**, and the tests assert that specifically:
the rules, limits, invoices and due dates all stay exactly where they are.

The Pricing page now carries a banner naming how many rules are held back —
without it the list calls every rule **Active** while some of them apply to
nobody.

### P0-3 · An out-of-order webhook dropped a paying merchant to Free

The handler wrote whatever the payload said, with no reference to which
subscription the shop was actually on: it ignored `admin_graphql_api_id`,
ignored `created_at`, and never compared against `existing.subscriptionId`.

An upgrade is precisely when Shopify emits two deliveries — the new
subscription going `ACTIVE`, the replaced one going `CANCELLED` — and their
order is not guaranteed. Cancellation second meant the merchant who had just
been charged for Growth lost every paid feature, under an audit line reading
"The pro subscription ended." Nothing repaired it.

**Fixed:** a terminal status for a subscription id that is not the cached one
is the replaced half of a plan change and is ignored, with a log line. A
*non*-terminal status for a different id is the new plan taking over and is
applied. When ids are absent — the field is optional in the payload — an older
`created_at` breaks the tie.

### P0-4 · An empty `billing.check` cancelled the plan and erased the grace period

`snapshotFrom([])` returned `FREE_SNAPSHOT` and `syncSubscription` wrote it
straight onto the row — `planKey: "free"`, `graceEndsAt: null` — on every Plans
page load, with an audit entry announcing a change that had not happened.

An empty list is not the same fact as "this shop cancelled". Shopify's `check`
filters by plan name **and** by test mode, so a renamed plan, a flipped
`SHOPIFY_BILLING_TEST_MODE`, or a frozen subscription Shopify omits all produce
one. The last is the cruellest: a merchant inside their documented 7-day grace
lost it the first time they opened the page they were told to open to fix their
card.

**Fixed:** `readSubscriptions` returns a distinct *unknown* answer, and the
caller decides. An unrecognised plan **name** never downgrades anybody — there
is a live subscription, we simply cannot read it — and an empty list downgrades
only where there is nothing to lose or the period the merchant paid for has
already ended. Otherwise the cached row stands, `graceEndsAt` included, the
reason is logged, and `billingSyncedAt` is stamped so the staleness check does
not call Shopify again on every page load in the one situation where that call
cannot help.

This also makes `snapshotFrom`'s own comment true. It said an unrecognised name
must not "silently cut off a paying merchant"; the code returned Free anyway.

### P0-5 · The $29 card sold the $59 plan's features

`planTagline.pro` read *"Net terms, shipping rules, draft orders, POS, Markets
— and the Merchant Agent"* while the comparison table immediately below it
marked all six **Not included** for Pro. The strings were written from
`docs/spec/pages-features.md`, where the tier names are the other way round
from `plans.ts`, and nobody reconciled them. A merchant who read the card and
subscribed had bought something they were not going to get.

**Fixed by deleting the list, not by correcting it.** The three paid taglines
are gone; each card composes its line from `featuresAddedBy(plan)` — the
capabilities that tier adds over the one below — using the `feature.*` labels
the comparison table already uses, joined with `Intl.ListFormat` so Arabic gets
its own conjunction rather than a comma. Move a capability between tiers and
the card and the table move together. Free keeps a written line, because it is
described by its limits rather than its capabilities.

A hand-kept list beside a real one is a registration step. That is the seventh
instance in this repo.

### P1-1, included because P0-2's honesty depends on it

`countUsage` still returned `{ pricingRules: 0, forms: 0 }` behind
`TODO(phase 1.3)` and `TODO(phase 2.2)`, long after both phases shipped. The
zeros were not inert: the meters read "Pricing rules 0 of 1" on a shop with
forty; the 80% warning and the at-limit banner could never fire; and
`planChangeFor` reported no overage for any downgrade, ever — on the screen
whose entire job is to name what will pause. Now counted, excluding archived
rows, which is the same condition the quota is checked against on create.

## Tests

The reviewer's probes are their record, not the suite. Every fix has a
committed test as well.

| Fix                          | Committed test                                                         | Probe | Reverted → fails with                                                           |
| ---------------------------- | ---------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| P0-1 CSV gate                | `tests/integration/csv-import.test.ts` (2 new)                         | F1    | `a Free shop imported rules from a CSV`                                           |
| P0-2 lapse pauses            | `tests/integration/billing.test.ts` (4), `plan-reconcile.test.ts` (8)   | F3    | `all five rules still apply at checkout on a lapsed subscription`                 |
| P0-3 webhook order           | `tests/integration/billing.test.ts` (4 new)                            | F4    | `a paying merchant was dropped to Free by the cancellation of the subscription they upgraded away from` |
| P0-4 empty answer            | `tests/integration/billing.test.ts` (4 new)                            | F5    | `the 7-day grace period was erased by one page load of /app/plans`                |
| P0-5 plan card               | `tests/unit/plans.test.ts` (3 new)                                     | F7    | the three hand-written strings no longer exist                                    |
| P1-1 usage meters            | covered by the above, and by F2                                        | F2    | `expected +0 to be 3`                                                             |

The reviewer's suite ran **9 failed / 2 passed** before. It now runs
**7 passed / 7 failed**, and every remaining failure is a P1 or P2 this round
did not claim: F6 (racy quota), F8 (annual trial price), F9 (four capabilities
sold that do not exist), F11 (no caller for the staleness check).

One fixture had to change: `tests/integration/settings.test.ts` created a shop
with `planKey: "growth"` and no `billingStatus`, which is a shop that never
subscribed — so its effective plan was Free and its rules capped at one. That
is the new behaviour working, not a regression; production writes both fields
together.

## What this does not prove

The same two things the cold read named, and for the same reason — no egress to
Shopify from this environment:

- a real `billing.request` / `billing.cancel` round trip;
- whether Shopify's `activeSubscriptions` includes a FROZEN subscription. That
  answer decides how often P0-4's refusal path is taken in practice. It no
  longer decides whether a merchant loses their grace period, which was the
  point.

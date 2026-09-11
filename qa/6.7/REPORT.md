# QA — 6.7 polish

## Part one: orders over time

Date: 2026-09-11 · Gate: **pass**

## 1. Test plan

`pages-features.md` §7: *"Wholesale vs. retail revenue, AOV, **orders over
time**"*. `feature-checklist.md` §7 lists neither AOV nor this; the split was
recorded in `DECISIONS.md` at 6.2 and deferred rather than dropped. AOV shipped
then as a stat line. This closes the other half.

The question that decides every choice here: **a count is not money.** Most of
the ways this feature could be wrong are a count borrowing something from the
revenue chart beside it — a currency symbol, a 1/2/5 axis, a line between two
whole numbers, a "Currency" column in the file.

States

| State | Where |
| --- | --- |
| Eight charts, orders among them | `qa/6.2/01-analytics-full` |
| Example page (invented counts, not a flat zero) | `qa/6.2/03-analytics-example` |
| Quiet window | `qa/6.2/09-analytics-empty-window` |
| 90 days | `qa/6.2/10-analytics-90-days` |
| Arabic, RTL, `many` plural at 35 and 12 | `qa/6.2/11-analytics-arabic` |

Abuse cases

1. A peak of three orders — does the axis label 3.75 of anything?
2. An order outside the window — clamped into the first bar, or dropped?
3. 23:30 UTC in Auckland — which day does a merchant there count it on?
4. A chart added to `CHART_KEYS` the ✦ router was never told about.

## 2. Automated

- `tests/unit/analytics-series.test.ts` +4 — `countByDay`: one per row, quiet
  days at zero, rows outside the window dropped, the store's own day, and no
  currency anywhere on the result.
- `tests/unit/analytics-geometry.test.ts` +2 — `wholeMax`: every tick a whole
  number at every peak from 1 to 101, never zero, never below the peak.
- `tests/unit/analytics-ai.test.ts` +2 — every `ChartKey` appears in
  `ASK_DATA_SYSTEM`, and the prompt offers nothing the page cannot draw.
- `tests/unit/analytics-view.test.ts` +1, and the empty-export loop now runs
  over `CHART_KEYS` instead of five hand-listed charts.
- `tests/unit/analytics-page-states.test.tsx` +2 — the legend counts orders and
  contains no `$`, the axis is whole, no `<polyline>`, and the "cancelled
  orders are not counted" note is present.
- `tests/integration/analytics-ai.test.ts` +1 — ✦ answers the orders chart in
  counts, cites `#orders`, and names a busiest day the orders fell on.

Each was watched failing: the page assertions against a build with the card's
heading swapped (1 failed, 18 passed), and the rest by construction against
code that did not exist before this task.

## 3. The states, walked

`qa/6.2` regenerated: 17 captures, re-screenshotted. **Looked at**, not only
asserted — the orders chart is visibly a different shape from the revenue chart
above it, the two series are side by side rather than stacked, and the Arabic
capture reads right-to-left with `الجملة · 35 طلباً` (the `many` category,
which is the correct one for 35 in Arabic).

Same caveat as every capture in this repo: Polaris never upgrades here, so this
is structure, not what a merchant sees.

## 4. Boundary

`loadAnalytics` is already `shopScope.require`d and every query inside it is
scoped; the new series is computed from rows that query already returned, so it
adds no query and no new surface. `tests/integration/analytics-ai.test.ts`
already proves one shop's charts hold no other shop's orders, and the new test
runs inside the same harness.

## 5. Invariants

1. **Pricing engine** — this chart holds no prices. The one number near it that
   is money, AOV, was already computed from `orderRevenue`.
2. **Shop scope** — §4.
3. **AI** — the ✦ router gained a chart, not an ability. It still names a chart
   and a window and computes nothing; `PROMPT_VERSIONS.ask_data` is bumped
   because the prompt text changed.
4. **Nothing claims to have happened that did not** — cancelled orders are
   excluded from this chart as they are from every other figure on the page,
   and the card says so, because a merchant counts orders in their head and
   would otherwise get a different number.
5. **Deciding shows its working** — the axis is labelled, both series are
   direct-labelled with their own totals, and every bar carries a `<title>`
   naming its day and count.

## 6. Bugs found and fixed in this pass

1. **The ✦ chart menu was a hand-kept list inside the prompt.** Adding `orders`
   to `CHART_KEYS` would have passed the validator while the model was never
   shown the chart — so no question could have routed to it, and nobody would
   have known. It is now generated from an exhaustive `Record<ChartKey, string>`
   and a test holds the two in step. Fourth instance of this shape in this repo.
2. **The example page would have drawn a flat zero orders chart** in the middle
   of a page of invented figures, which reads as "and you have no orders"
   rather than as an example. `exampleView` gets its own counts.
3. **`niceMax` on a count axis.** Three orders would have been labelled 5, 3.75,
   2.5, 1.25, 0.

## 7. Not covered here

- No merchant has seen this rendered by Polaris (environment).
- The chart has never drawn a real store's orders (no dev store).


---

# Part two: the three things that were registered and never built

Date: 2026-09-11 · Gate: **pass**

## 1. Test plan

Three checklist lines had a name in the code and nothing behind it:

- §3 *"last order (+ ✦ 'due to reorder' chip when prediction fires)"* —
  `dueToReorder` has been a hardcoded `false` in the customer view model since
  2.1, under a comment saying it needed the AI layer, and `reorder_prediction`
  has carried a prompt version since 4.1 with no prompt.
- §5 *"✦ Risk signal: chip per buyer (on-time streak / 2 late payments);
  suggested action only, never auto-changes terms"* — `terms_risk`, same shape:
  a prompt version, no prompt, no caller, nothing on any screen.
- §6 *"greeting (personalized: name, tier, last order)"* — 5.2 shipped the name
  only and `PROGRESS.md` has carried the gap since.

**Neither of the first two needs a model.** Appendix B: the model never
computes what a deterministic module can. "Orders about every 21 days and it
has been 24" and "two of the last six were late" are arithmetic on rows this
app already stores; a sentence from Claude saying the same thing would be the
same number with a licence fee, a timeout and a way to be wrong. Both AI
registry entries are deleted rather than left as names for features that do not
exist.

Abuse cases invented for this pass

1. A buyer with exactly two orders — is one interval a rhythm?
2. A holiday shutdown in the middle of an otherwise regular pattern.
3. Two orders on the same day (a split shipment) — a rhythm of nought days?
4. An invoice paid two days late by a Friday payment run.
5. A part payment — settled, or not?
6. Three on-time payments and one invoice overdue right now.
7. Every one of the above, read from another shop's rows.

## 2. Automated

`tests/integration/reorder-and-risk.test.ts` — 19 tests, all new: six on
cadence, eight on payment history, five on the greeting. Each was watched
failing; one of them caught a fixture setting `paidAt` with nothing paid, which
`recordPayment` never writes — the helper now mirrors the production writer so
the fixture cannot drift again.

Plus the two state tests (`05-buyers-badges` gains the reorder chip and its
sentence; `terms-risk` is a new capture with all three tones), and the
storefront block budget — see §6.

Whole suite: see the run recorded with the commit.

## 3. The states, walked

- `qa/2.1/05-buyers-badges` — the reorder chip beside the at-risk, pending,
  tax-exempt and deleted ones, with its sentence next to it.
- `qa/3.2/terms-risk` — good, watch and late, in three tones.

The greeting is the one part of this with no capture: it is a line of text in
a theme block on a storefront, which this environment cannot render. It is
covered by the integration tests and by the block's own budget test.

## 4. Boundary

`cadenceFor`, `riskFor` and `greetingFor` all begin with `shopScope.require`,
and each has a test seeding the same Shopify customer GID in another shop and
asserting the first shop reads nothing. That matters more here than usual: all
three are keyed on Shopify's customer id, which is the same value in every shop
that customer has ever bought from.

## 5. Invariants

1. **Pricing engine** — none of this is a price.
2. **Shop scope** — §4.
3. **AI drafts, a person approves** — two AI features were *removed*. Nothing
   here calls a model, and the chips are suggestions: no terms, credit limit or
   group changes from either.
4. **Nothing claims to have happened that did not** — the reorder chip is not
   marked ✦, because ✦ marks what Claude wrote and this is arithmetic. Neither
   chip appears for a buyer with too little history to have one: no rhythm from
   two orders, no "always pays on time" from a first invoice.
5. **Deciding shows its working** — both chips say what they counted, in the
   merchant's own numbers, beside themselves rather than in a `title` tooltip a
   merchant on a phone cannot read.

## 6. Bugs found and fixed in this pass

1. **The Buyer Agent block was at 99.2% of its byte budget** (16,261 of 16,384)
   and any addition would have broken it. The guard was measuring the file on
   disk — which counts `{% comment %}` blocks and `{% schema %}`, neither of
   which Shopify ever serves. So the budget was pushing against the one thing
   it has no business discouraging: writing down why storefront code is the way
   it is. It now measures what a buyer downloads, with a second test that fails
   if the strip ever stops matching. JavaScript comments are still counted,
   because those really are shipped — and the new code's were trimmed to suit.
2. **A conversation's transcript had no defined order.** `answerBuyerTurn`
   stamps both halves of a turn with one `now` — deliberately — and every read
   of a thread ordered by `createdAt`, so Postgres was free to return equal
   timestamps in either order. A merchant reading the log could find the
   agent's reply above the question it answered. It surfaced as a one-in-many
   test failure during this pass; `AgentMessage.seq` (a migration) gives the
   total order, every reader uses it, and the test now asserts both that the
   two share a timestamp and that the order is still right.
3. **A fixture wrote a row `recordPayment` cannot produce** — `paidAt` stamped
   with `amountPaid` at zero. Caught while the tests were red, fixed in the
   helper rather than per case.
4. **Two captures said two contradictory things at once** — a row marked
   overdue labelled "Due in 12 days", and a buyer whose last order was "10 days
   ago" beside "it has been 24". Neither is a row a loader can build.

## 7. Not covered here

- No greeting has been seen in a real storefront (no dev store).
- Neither chip has been read off a real store's orders.

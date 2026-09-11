# QA — 6.7 polish, part one: orders over time

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

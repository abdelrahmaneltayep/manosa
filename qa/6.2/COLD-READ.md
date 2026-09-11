# Cold read — 6.2 The analytics page

Independent adversarial review. I did not write this code and did not read the
author's report until after I had read the diff.

Commit under review: `ad7a048` · branch `claude/mannon-b2b-wholesale-oc5b18`
Date: 2026-09-11 · Reviewer hat: senior QA, hostile

## Verdict: **FAIL**

Three findings are P0. The headline revenue figure on the page is wrong after
any refund and contradicts two other screens in this app; a shop with real
sales is shown invented numbers whenever the selected window is quiet; and the
net-terms aging chart disagrees with `/app/orders/terms` by construction — its
"over 30 days late" bucket can never be filled by a real invoice.

Every finding below was reproduced. The probes are archived at
`qa/6.2/probes/analytics-probe.test.ts.txt` (integration, 7 probes, all fail
against `ad7a048`) and `qa/6.2/probes/render-probe.test.tsx.txt` (SVG geometry).
Rename either to `.ts`/`.tsx` under `tests/` to re-run.

What I ran: `npx tsc --noEmit` (clean), `npm run lint` (clean),
`npx vitest run tests/integration/analytics.test.ts` (19/19 green — and see
F-15 for why that is not reassuring), plus the two probe files. I did not run
the whole suite or Playwright, per the brief.

---

# P0 — a merchant reads a number that is not true

## F-1 · Every money figure on the page subtracts the refund twice

**Where:** `app/lib/analytics/charts.server.ts:167-168` (`net`), used at
`:172` (both revenue series), `:192` (top buyers), `:277` (by group), and
again at `:432` (aging). Root cause is the same expression in all five.

```ts
const net = (order: { totalPrice: number; refundedAmount: number }) =>
  Math.max(0, order.totalPrice - order.refundedAmount);
```

`Order.totalPrice` is written from Shopify's **`currentTotalPriceSet` /
`current_total_price`**, which is already net of refunds and edits
(`app/lib/orders/sync.server.ts:284`, `:562`). The repo states this itself in
three places:

- `tests/unit/orders-sync.test.ts:98` — *"prefers the current total, which is
  the number after edits **and refunds**"*.
- `tests/integration/orders.test.ts:306-317` — a $1,200.50 order with a $40
  refund arrives as `current_total_price: "1160.50"` and is stored as
  `totalPrice: 116050, refundedAmount: 4000`. 1200.50 − 40 = 1160.50.
- `docs/adr/0024` addendum — *"The parent `Order` row is written from the
  `current_*` fields"*.

So subtracting `refundedAmount` again removes the refund a second time.

**Reproduction** (probe A, run through the real webhook writer):

| Fact | Value |
|---|---|
| Order, as Shopify reports it after a $40 refund | `current_total_price 60.00`, `total_refunded 40.00` |
| Stored row | `totalPrice: 6000`, `refundedAmount: 4000` |
| **Analytics revenue chart / by group / top buyers** | **$20.00** |
| Home KPI "wholesale revenue" (`kpis.server.ts:113` — `_sum(totalPrice)`) | $60.00 |
| Orders list order total (`orders/view-model.server.ts:89`) | $60.00 |
| Analytics **top products** chart (line `currentTotal`) | $65.00 |

Four numbers for one order, three of them on screens a merchant can open side
by side. The merchant's actual receipts are $60.00.

**Blast radius:** wholesale and retail revenue series and their totals, revenue
by group, top buyers, the aging amounts, and every CSV derived from them. The
error equals the refunded amount, so it grows with exactly the orders a
merchant investigates most.

**Note on the aging chart:** `:432` repeats the same subtraction, which matches
`app/lib/terms/terms.server.ts:66` and `ledger-query.server.ts:54`. Those are
3.2 code, so the chart and the ledger agree with each other — and both
understate what is owed after a refund. Fixing `net()` without fixing
`toInvoice()` will make the two screens disagree; fix both, in one change.

**Fix sketch:** revenue is `order.totalPrice`, full stop. If a gross figure is
ever wanted, it is `totalPrice + refundedAmount`, not the other way round.

---

## F-2 · A shop with real sales is shown somebody else's numbers

**Where:** `app/lib/analytics/view-model.server.ts:155-161` (`hasAnyData`),
called on **window-scoped** data at `app/routes/app.analytics._index.tsx:50`
and `app.analytics.export.tsx:105`.

`hasAnyData` reads `data.revenue.*.total` and `data.funnel` — all three of
which are computed **for the selected window**. Its own doc comment says the
opposite (*"deliberately not 'is this window empty'"*), as does
`view-model.server.ts:121-122` (*"An example is shown only when there is
genuinely nothing — not when a window happens to be quiet"*). The code does not
do this.

**Reproduction (probe B.1):** shop installed January, one $100 wholesale order
on 1 Sep, viewing 30 Sep.

- `?range=90` → the merchant's own data.
- `?range=7` → `hasAnyData` returns **false** → `exampleView()` →
  "Café Aroma $1,800.00", "House Blend 1kg $900.00", a 48→31→22 funnel, and
  $4,200 of net-terms aging. **None of it theirs.** Clicking between the three
  range links makes their business appear and disappear.

**Reproduction (probe B.2), worse:** a shop whose orders in the window are all
in another currency. `excludedOrders` is 1, revenue is 0, so `hasAnyData` is
false → the example renders — and `exampleView` sets `excludedOrders: 0`
(`view-model.server.ts:218`), which **removes the warning banner explaining why
their revenue is zero**, precisely when it is the only true thing on the page.
The same line clears `ordersMissingLines` and `partial`.

This is invariant 4 in its purest form: the page tells a merchant they have
never sold wholesale when they have, and hides the sentence that would have
explained the zero.

**Fix sketch:** `hasAnyData` must ask a window-independent question — e.g. a
`db.order.count({ where: { isWholesale: true } })` (no date bound) plus a
`formSubmission.count()` — and the example must be suppressed whenever
`excludedOrders > 0`. See F-15 for the test that should have caught this.

---

## F-3 · The aging chart cannot agree with `/app/orders/terms`, and its worst bucket is unreachable

**Where:** `charts.server.ts:204` feeds `agingFor()` from `wholesaleOrders`,
which is filtered at `:136` by `processedAt: { gte: start, lte: now }`.

An aging report is about invoices that are *late*. A late invoice was issued
long ago — usually further back than the window. The ledger
(`app/lib/terms/ledger-query.server.ts:48`) deliberately has **no date filter**
for exactly this reason.

**Reproduction (probe C):** two unpaid Net-30 invoices, nothing else.

| Invoice | Issued | Due | Overdue |
|---|---|---|---|
| #1 $500 | 45 days ago | 15 days ago | 15 days |
| #2 $900 | 100 days ago | 70 days ago | 70 days |

`/app/orders/terms` (`ledgerPage`): `days_1_15 = $500.00 (1)`,
`days_30_plus = $900.00 (1)`.
Analytics, default 30-day window: **every bucket 0, every count 0**, and the
card says "Nothing in this window."

$1,400 of overdue money, invisible, with a heading that reads "Net terms
aging". The page does not say it is windowed — the range picker is at the top
of the page and reads as a filter on *time series*, not on a standing balance.

**Structural consequence:** with `range=30`, an invoice can only land in
`days_30_plus` if it was due more than 30 days before it was processed. The
author's own test had to construct exactly that impossible order to reach the
bucket — `tests/integration/analytics.test.ts:381-388` processes an order on
2026-09-21 with `dueAt: 2026-08-01`, i.e. due 51 days before it existed. A
bucket that only a physically impossible fixture can fill is a bucket that will
read "$0.00" on every real store, forever.

**Fix sketch:** the aging chart is a standing metric, not a period metric (the
distinction `kpis.server.ts:7-13` already draws). Query it the way the ledger
does — no window — and label the card "as of today" rather than letting the
range picker imply otherwise.

---

# P1 — wrong population, wrong bucket

## F-4 · The funnel's third step counts orders that have nothing to do with the application

**Where:** `charts.server.ts:394-403`.

```ts
where: { customerId: { in: approvedIds }, isWholesale: true }
```

No date bound, no `cancelledAt: null`, no "after the submission". The step is
documented (`:375-381`) as following *the same cohort as it moves*, and the
funnel card reads "Ordered / of the step before".

**Reproduction (probe D):** one buyer applies on 25 Sep and is approved. Their
only order is from **5 January** and was **cancelled the next day**. Result:

```
[submitted 1] [approved 1] [ordered 1]   →  the page claims 100% conversion
```

A cancelled, pre-application order is reported as "this buyer ordered after we
approved them". On a store that converts existing retail buyers to wholesale —
the normal case for this product — this inflates the funnel's last step
systematically.

**Fix sketch:** `cancelledAt: null` plus `processedAt: { gte: <the
submission's createdAt> }`, which means grouping by submission rather than one
`in` query, or a two-column fetch and a filter in memory.

## F-5 · The top-products chart does not reconcile with the revenue chart above it

**Where:** `charts.server.ts:305` sums `OrderLine.currentTotal` while
`:172` sums order totals. The two are different quantities: line totals exclude
shipping, tax and order-level discounts, and (per F-1) the revenue figure is
additionally short by the refund.

From probe A's single-order shop: revenue chart **$20.00**, top products
**$65.00**. Even with F-1 fixed it would read $60.00 vs $65.00 — the line sum
exceeding the order sum, which looks like a bug to any merchant who checks.

Nothing on the page says the product and rule charts are line-level and the
revenue chart is order-level. The rules card carries a `analytics.rules.note`
explaining a *subtler* caveat (renamed rules); this one has no note at all.

**Fix sketch:** one sentence under the products and rules charts — "line totals,
before shipping and tax" — and make sure both sides handle refunds the same way.

## F-6 · "Last 7 days" draws 8 bars, and the first one is a part-day drawn full width

**Where:** `charts.server.ts:117` (`start = now − range × DAY`) with
`series.server.ts:43` (`daysBetween` is inclusive of both local days).

**Reproduction (probe E):** at `2026-09-30T12:00Z`, `range=7` produces
`start = 2026-09-23T12:00Z` and **8 buckets**, `2026-09-23 … 2026-09-30`. An
order at `2026-09-23T07:00Z` is excluded (before `start`) yet the 23rd gets a
full-width bar. The same applies to the last bucket, which is truncated at
"now".

So the first and last bars of every window systematically under-report, and the
range label ("Last 7 days") disagrees with the axis (8 days). The existing test
at `tests/integration/analytics.test.ts:126-129` asserts the 8 and calls it
correct without noticing that bucket one is half a day.

**Fix sketch:** snap `start` to the beginning of the store-local day
`range − 1` days back (`localDay` already exists), so a "7 day" window is seven
whole local days.

---

# P2 — the marks themselves

I rendered states the capture set never rendered (`render-probe.test.tsx.txt`)
and read the committed PNGs.

## F-7 · In Arabic, every value label is drawn on top of its own bar

**Where:** `app/components/analytics/Charts.tsx:257-263` (and the identical
blocks at `:297-303`, `:335-341`). The `<text>` has no `text-anchor`, so it
defaults to `start` — which in an RTL document resolves to the **right** edge of
the text. `app/root.tsx:50` sets `dir="rtl"` for Arabic, and the SVG inherits
it.

Result: the label is anchored just past the bar's end and extends **leftwards,
across the bar**. Visible in the committed capture
`qa/6.2/11-analytics-arabic.png` — compare the "أكبر مشتري الجملة" and "أكثر
منتجات الجملة مبيعًا" charts with the same charts in `01-analytics-full.png`.
Dark `--mn-ink` text over `#2a78d6` fill: a label sitting on its own mark, and
almost certainly under AA.

Meanwhile `withEndRoom` (`geometry.ts:47-50`) reserves up to 40 viewBox units
of padding on the **right**, where in RTL nothing is ever drawn — so the plot is
squeezed *and* the label collides.

**Fix sketch:** the charts are physical-coordinate SVG, so either mirror the
whole plot for RTL or set `text-anchor="start"` explicitly with
`direction="ltr"` on the value text. Add an Arabic ranked-chart capture that a
reader would notice this in.

## F-8 · The revenue chart has no value axis, no markers, and no tooltips

**Where:** `Charts.tsx:100-197`; `geometry.ts:22-31` reserves `padStart: 2`
described as "Room for the value axis" — nothing is ever drawn there.

From the committed capture's markup (`qa/6.2/01-analytics-full.html`): five
`<line class="mn-grid">`, one axis line, two `<polyline>`, seven day labels.
**No numeric label anywhere on the chart.** And in the non-partial (default)
branch the polylines carry no `<title>` and no per-point circles, so there is no
hover value either. The only readable figures are the two legend totals.

This also makes the file-level claim at `Charts.tsx:32-33` false —
*"Each chart ships with `<title>` on every mark — a real tooltip, from the
browser, for free"* — and the author's report repeats it under "No hover layer".
It is true of the bars and the ranked charts; it is not true of the chart the
page leads with.

`niceMax` makes this worse rather than better: with a peak of 12.3M it returns
20M (`geometry.ts:66-74`), so the tallest mark reaches 62% of the plot and the
reader has no label to tell them why.

## F-9 · The trend line, the day labels and the annotation rules use three different x formulas

**Where:** `geometry.ts:155-161` (line: `n − 1` spacing, edge to edge) vs
`Charts.tsx:189` (labels: slot centres, `n` slots) vs `Charts.tsx:115-116`
(annotations: slot centres).

From the probe render (31 points): the last data point is at `x=98`, the label
naming it is centred at `x=96.45`; the first point is at `x=2`, its label at
`x=3.55`. Every point on the trend line is drawn half a slot away from the day
it belongs to, and the "Mannon installed" rule at `x=87.16` misses the data
point for that same day at `x=88.4`.

On a 7-day window that offset is ~7% of the chart width — half a day. The whole
point of the annotation is "the line starts at zero *here* because the app
arrived"; it does not point at that spot.

## F-10 · Annotation labels run off the chart and overlap each other

**Where:** `Charts.tsx:123` — `<text x={x + 0.6} y={box.y + 2}>` with no
anchor, no width check, no collision handling. SVG clips at the viewBox, so the
overflow is silent.

Probe render, 31-day window, install annotated 3 days before the end:

```html
<text class="mn-label" x="87.75999999999999" y="5">Mannon installed</text>
```

At `font-size: 2.1` (`palette.ts:98`), 16 characters is roughly 17 viewBox
units, so the label ends near `x≈105` in a 100-unit box — the last four or five
characters are cut off. "Buyer Agent published" (21 characters) is cut from
`x≈83` onward. That covers the final ~5 days of a 30-day window and the final
~15 days of a 90-day window — i.e. a shop that installed recently, or published
the agent recently, which is when these marks matter most.

Two annotations within ~20 units of each other (install and publish in the same
fortnight — the normal onboarding path) are both drawn at `y = 5` and overlap.

Also note the unrounded float in the attribute: every other coordinate in this
file goes through `round()`; this one does not.

## F-11 · The example state puts all card text below AA contrast

**Where:** `palette.ts:107` — `.mn-viz--example { opacity: 0.55 }` — applied at
`AnalyticsPage.tsx:43` to the wrapper around **all seven cards**, not just the
SVGs. That includes every table, every number, and seven "Export this chart
(CSV)" links.

`--p-color-text` `#1a1a1a` at 55% over white is ≈ `#818181`: contrast ≈ 3.9:1,
under the 4.5:1 AA floor CLAUDE.md asks for "as you build". `color="subdued"`
text (`#616161`) lands near 2.4:1. Interactive links are included.

**Fix sketch:** wash out the marks (`.mn-viz svg`), not the text; the banner and
the labelled rows already carry the message.

## F-12 · A ranked row can render a bar too small to see

**Where:** `geometry.ts:130-135` — `rows()` clamps the bar's *thickness* but
not its *length*; `columns()` has `Math.max(0.5, …)` for width and nothing for
height either.

Probe render: values 12,345,678 and 2,000 give
`<rect … width="0.01" …>` — at a 660px-wide card, 0.07 of a pixel. The row's
label and money are still drawn, next to nothing. On a top-10 with one dominant
buyer, the tail renders as a column of floating numbers with no marks.

## F-13 · "Everyone else" is drawn as though it were a buyer

`series.server.ts:113-123` appends the remainder row last, after the
descending sort, and `RankedChart` gives it the same hue as every named row
(`Charts.tsx:246`). When the tail is large it is the longest bar on the chart
and it sits at the bottom, so the chart is neither sorted nor legible as "this
one is not a buyer". The table marks it subdued (`AnalyticsPage.tsx:277`); the
chart does not.

---

# P3 — spec, process, and things that will mislead the next session

## F-14 · The loading state required by checklist §7 does not exist

> §7: *"Loading: skeleton chart + tiles."*

There is no skeleton in `AnalyticsPage.tsx`, no loading branch in
`AnalyticsView`, no capture, and no row for it in the author's own state table
(`qa/6.2/REPORT.md` §2). The repo has the pattern already
(`app/components/customers/CustomerListPage.tsx:97-105`). The range picker is
three plain `<s-link>`s doing full navigations against a loader that runs seven
unbounded queries (F-17), so this is a real gap, not a theoretical one.

## F-15 · Two of the tests in `tests/integration/analytics.test.ts` cannot fail

Both guard the two P0s above, which is why they shipped.

1. **`:146` "takes refunds off, as every other figure in this app does"** writes
   `refundedAmount: 4_000` onto a row with `db.order.update` while leaving
   `totalPrice` at 10,000 — a combination the writer cannot produce, because
   the writer sets `totalPrice` from `current_total_price`, which Shopify has
   already reduced. This is precisely the anti-pattern `docs/adr/0024`'s own
   addendum names: *"a fixture that sets a value the production writer never
   sets is a test that cannot fail"*. One task later, in the same area.

2. **`:444` "is not offered for a window that is merely quiet"** sets up a quiet
   7-day window, binds it to `quiet`, asserts `quiet.revenue…total === 0` — and
   then calls `hasAnyData(await load(90))`, a **different window**. It never
   asserts `hasAnyData(quiet)`, which is the only thing the test is named for
   and the only thing production calls. `hasAnyData(quiet)` is `false`.

## F-16 · The capture set claims more than it contains

`md5sum qa/6.2/*.png`: **five of the eleven PNGs are byte-identical** —
`01-analytics-full`, `02-analytics-footer`, `07-analytics-rules`,
`08-analytics-funnel` and `10-analytics-90-days` are the same image. The first
four render the identical default `view()` (`analytics-page-states.test.tsx:138,
151, 224, 233`); the fifth differs only in which range link carries
`aria-current` and what `range=` the export links say.

So **`10-analytics-90-days` shows a 7-point chart**. No capture in this task has
ever rendered a 31- or 91-point series, which is every real 30- or 90-day
window — which is why F-9 and F-10 were not seen. The report's "12 state
captures" is closer to six distinct renders.

## F-17 · The loader has no ceiling on anything

`charts.server.ts:140` pulls **every** order in the window with `findMany` and
no `take`; `:292` and `:328` then each run a separate `findMany` over
`OrderLine` for the same `orderId` list, so every line of every order is
materialised in Node **twice** per page view, plus once more per CSV export.
`revenueByGroup:257` sends the full customer-id list as an `IN (…)`.

For the 10k-order store Appendix A asks us to test against, a 90-day view is
hundreds of thousands of rows and two identical scans, on a page carrying an
LCP ≤ 2.5s acceptance criterion. At minimum, fetch the lines once and pass them
to both consumers; better, aggregate in SQL (`groupBy`) rather than in memory.

## F-18 · `pages-features.md` §7 asks for AOV and orders-over-time; neither exists

> §7 core features: *"Wholesale vs. retail revenue, **AOV**, orders over time"*

The page charts revenue over time only. There is no AOV anywhere in the app
(`kpis.server.ts:54-59` has revenue, orders, approvals, rules, outstanding — no
AOV), and no order-count series. `feature-checklist.md` §7 does not list them,
so this is a genuine spec disagreement rather than an oversight — but per
CLAUDE.md stop condition 6 it should have been quoted and decided in
`DECISIONS.md`, and it was not.

## F-19 · The revenue CSV exports minor units with no label and no formatted column

`csv.server.ts:60-68`: the revenue file's columns are `Day, Wholesale, Retail,
Currency` and the values are raw minor units. Every *other* chart's CSV labels
that column `Amount (minor units)` **and** ships a formatted `Amount` beside it
(`:74-79`, `:95-103`, `:141-148`), exactly as the module's own doc comment at
`:10-12` promises. A merchant opening `mannon-revenue-30d.csv` sees `12000` for
a $120.00 day, in a column headed "Wholesale".

## F-20 · Revenue by group silently rewrites history

`charts.server.ts:257-267` joins to the buyer's **current** group. Move a buyer
from Silver to Gold today and every order they have ever placed moves with
them; last quarter's chart changes retroactively. That may be the right choice
— but the rules card discloses the *analogous* hazard in a note
(`analytics.rules.note`) and this chart says nothing, which is invariant 5.

---

# What I checked and found correct

Stated so the fix round does not re-litigate it:

- **Tenant isolation is sound.** Every new query goes through the scoped client;
  `orderId: { in: … }` lists are built from `db.order.findMany` inside the scope
  and the extension injects `shop` on the `OrderLine` read as well
  (`shop-scope.server.ts:138-150`). The route surface accepts only `range` and
  `chart` — there is no id parameter to probe with. The existing cross-tenant
  test (`analytics.test.ts:460`) is real and passes.
- **DST.** `daysBetween`'s 12-hour walk neither skips nor repeats a day. I ran it
  across America/New_York spring-forward and fall-back, Pacific/Chatham's
  45-minute offset, and Pacific/Kiritimati (UTC+14): 8 days every time, correct
  endpoints.
- **Timezone hardening.** `knownTimezone` (`shop/domains.server.ts:189`) rejects
  a zone `Intl` does not know at the boundary, so a garbage `ianaTimezone`
  cannot reach `localDay`. Null is handled and the footer says UTC.
- **CSV injection.** `csvCell` defuses `= + - @ \t \r` and doubles quotes; tested
  with `=cmd|' /c calc'!A1`. The `chart` parameter is a closed vocabulary with a
  400 for anything else; `range` falls back to the default.
- **i18n.** All 46 `analytics.*` keys exist in both catalogues; all five
  count-bearing keys have `_one`/`_other` in English and all six categories in
  Arabic, and all five are called with `count`. The capture guard derives its
  roots from `en.json`, so `analytics.` is covered (note: the guard only matches
  text nodes, not attributes — a raw key in an `aria-label` would still slip).
- **Conventions.** No `any`, no `@ts-ignore`, no `console.log`, no commented-out
  code, no boolean props on `s-*` elements (the `aria-current` spread at
  `AnalyticsPage.tsx:155` is the correct pattern), no `.only`/`.skip`.
  `tsc --noEmit` and `eslint --max-warnings 0` are clean. No secrets: every data
  module is `.server.ts` and the client bundle gets only `geometry.ts`,
  `palette.ts` and `types.ts`, all pure.
- **Buckets.** `bucketByDay`'s running total only counts rows that landed in a
  bucket, so the legend total always equals the sum of the bars.
- **The palette reasoning** in `palette.ts` is sound and the ordered/nominal
  distinction is the right call; F-7 and F-11 are about placement and opacity,
  not hue.

---

# Suggested order of work

1. F-1 (with the `toInvoice` counterpart), F-2, F-3 — these are why the verdict
   is FAIL. Each needs a test written from the **writer's** output, not from a
   hand-built row.
2. F-15 — rewrite the two tests that could not fail *before* fixing F-1 and F-2,
   and watch them go red.
3. F-4, F-5, F-6.
4. F-7 … F-13, then re-capture with a 31-point and a 91-point series and an
   Arabic ranked chart, so F-16 stops being true.
5. F-14, F-17 … F-20.

A re-run of the full gate is required after the fixes; this cold read does not
carry over.

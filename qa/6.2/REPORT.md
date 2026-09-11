# QA — 6.2 The analytics page

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-11 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

## 1. Scope

Checklist §7's charts and their states: wholesale vs retail revenue over time,
revenue by group, top buyers, top products, pricing-rule performance, the
registration funnel and the net-terms aging report; the empty, partial and
annotated states; a CSV per chart; and the footer that says what currency and
what timezone every figure is in.

Not in it: the two ✦ features (ask-your-data, the monthly review) — 6.3.

## 2. Test plan

Spec re-read: `feature-checklist.md` §7, `pages-features.md` §7, `docs/adr/0024`
(the line data these rest on), and `CLAUDE.md` → Invariants 1, 2 and 4.

**States:**

| Condition                                   | What happens                             |
| ------------------------------------------- | ---------------------------------------- |
| Never sold anything                         | worked example, labelled twice, washed out |
| This window is quiet, but the shop has sold | "Nothing in this window" — not an example |
| Under 7 days of history                     | daily bars, **no** trend line, and why   |
| Installed mid-window                        | the install day is marked on the chart   |
| Buyer Agent published mid-window            | that day is marked too                   |
| Orders in another currency                  | counted, named, never folded in          |
| Orders whose lines came back short          | said on the products chart               |
| A rule renamed since the order              | its old name, badged "renamed or removed"|
| Shopify's timezone not read yet             | footer says UTC, rather than claiming    |
| Arabic                                      | RTL, and the whole page translated       |

**Three abuse cases I invented:**

1. **A company name that is a formula.** `=cmd|' /c calc'!A1` as a buyer name,
   straight into the CSV a merchant opens in Excel.
2. **A funnel that widens.** Approvals from before the window counted against
   submissions inside it, so more buyers are approved than ever applied.
3. **Wrong-tenant everything.** β's orders, lines, groups and rules, read from
   α's analytics page.

## 3. Automated

New:

- `tests/unit/analytics-series.test.ts` — 13 (bucketing, DST, top-with-rest)
- `tests/unit/analytics-geometry.test.ts` — 18 (marks, axis, label room)
- `tests/unit/analytics-view.test.ts` — 12 (shares, day labels, CSV)
- `tests/unit/analytics-page-states.test.tsx` — 12 (also the captures)
- `tests/integration/analytics.test.ts` — 19 (the six datasets, end to end)

**Whole suite: 1,957 unit + integration across 104 files, green.** `npm run
lint`, `npm run typecheck`, `npm run build`, `npm run format:check` clean.

Properties worth naming:

- **A day is the store's day.** 8pm UTC lands in tomorrow's bar for a Sydney
  merchant, asserted directly; the day walker neither skips nor repeats a day
  across a clock change in either direction.
- **An empty day is a bar of zero**, not a missing bar — dropping them
  compresses a quiet fortnight into a busy-looking line.
- **A "top ten" adds up.** The tail becomes one "everyone else" row rather than
  vanishing, because the first thing a merchant does with a top-ten is check it
  against the total.
- **Two currencies are never added.** An order in another currency is excluded
  from every figure and reported in a banner with its count.
- **A refunded line earns its product and its rule nothing** — `currentTotal`,
  per 6.1's fix round, not the ordered figure.
- **The funnel cannot widen.** Approvals are approvals *of submissions in this
  window*, asserted with an out-of-window approval present.
- **A rate computed from nothing is blank**, on screen and in the CSV — never
  `0%`.
- **The worked example never reaches a file.** A CSV has no watermark, so for a
  shop with no data every export is its header row and nothing else.

## 4. Boundary

β's orders, lines, groups and rules are invisible in α: revenue 0, no products,
no rules, no groups. Every query runs inside the scoped client.

## 5. Invariants

1. **Every price comes from the engine.** Nothing here is a price. These are
   sums of what Shopify already charged, and the module imports the engine only
   for `money` and the aging summariser.
2. **Every query is shop-scoped.** §4 probes it four ways.
3. **AI drafts; a person approves.** No AI path on this page — 6.3 adds one.
4. **Nothing claims to have happened that did not.** The load-bearing invariant
   here: excluded currencies are named, truncated line sets are named, a blank
   conversion rate stays blank, a shop with no history is shown an example
   twice-labelled rather than zeros, and the footer states the currency and the
   timezone rather than letting a reader assume them.
5. **Deciding shows its working.** The rule chart carries the name the buyer saw
   at checkout and says when no current rule has it.

### The palette, and why these hexes

The chart colours were chosen against a validator rather than by eye, and every
set was run against `#ffffff` and `#1a1a1a` — the surfaces a Polaris card
actually paints:

- **Wholesale vs retail** (the only categorical chart): light `#2a78d6`/`#eb6834`,
  dark `#3987e5`/`#d95926`. All checks pass in both modes; worst CVD ΔE 24.7
  light, 26.8 dark, against a floor of 8.
- **The ordered ramps** (funnel, aging): one hue, light→dark, four steps. Light
  `#86b6ef → #104281`, dark `#cde2fb → #256abf`. Monotone with visible steps,
  light end clear of the surface. The first ramp I tried failed the adjacent-ΔL
  check on one pair and was re-stepped, not argued with.
- **Every nominal chart is one colour.** Shading bars darker-where-bigger would
  encode the bar's length twice and say nothing its length does not.

Identity never rests on colour: the two-series chart carries a legend with both
totals direct-labelled, and every chart ships with its data table beside it.

## 6. Bugs found by this gate, and fixed

1. **The longest bar's value label ran out of the chart.** Caught by looking at
   the rendered screenshot, not by a test: the longest bar reaches the full plot
   width and its label is drawn past the end of it, so the one row a reader most
   wants to read was the one whose number was cropped. Room is now reserved
   from the longest label, and a test asserts the label end stays inside the
   viewBox.
2. **A fixture that formatted money differently from production.** The capture
   fixture wrote `$10600.00` where `formatCurrency` writes `$10,600.00` — a
   fixture that formats money its own way is a fixture that hides a formatting
   bug. Now built with `Intl.NumberFormat`.
3. **Analytics was written as plan-gated and is not.** §7 lists these charts
   under parity, not under a paid tier, and there is no `analytics` feature key.
   The gating code and its two view fields were removed rather than left dead —
   see `DECISIONS.md`.

## 7. Open, not passed

- **No cold read yet.**
- **No merchant has seen this page.** Polaris never upgrades here. What is
  different from every previous task: **the marks themselves are ours**, so the
  SVG in these captures is byte-for-byte what a browser gets, and bar geometry,
  label placement and the legend genuinely are verified. The Polaris chrome
  around them is still a stand-in, and the chart's rendered *width* depends on
  a card that does not upgrade here — so the captures are narrower than a real
  admin, and font sizes relative to that width cannot be judged from them.
- **No hover layer.** Every mark carries an SVG `<title>`, which is a real
  browser tooltip with no client script, and every chart ships with its table.
  A crosshair tooltip would mean client JS in an embedded admin page and would
  break the capture discipline this environment depends on. Stated as a
  deliberate deviation rather than an oversight.
- **Dark mode is declared but unverifiable here.** The dark steps are validated
  arithmetically against `#1a1a1a`; no screenshot of them exists, because the
  capture harness renders one theme.
- **60 days is the reach.** `read_orders` caps there without
  `read_all_orders`, so a 90-day window shows what it has. The footer says so.
- **Nothing has been measured against the Built for Shopify budgets.** The page
  ships no client JS and one inline `<style>`, which is the right shape for LCP
  and CLS, but the numbers are unmeasured.

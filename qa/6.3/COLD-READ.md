# Cold read — 6.3 ✦ ask-your-data and the ✦ monthly review

Independent adversarial review. I did not write this code and I did not trust
`qa/6.3/REPORT.md`; every claim in it was re-derived from the source, the
database and the rendered PNGs.

Commits under review: `7a05849`, `adcaf92`, `8995999`.
Branch: `claude/mannon-b2b-wholesale-oc5b18` · Date: 2026-09-11

## Verdict: **FAIL**

Two P0s, three P1s, eleven P2s. The headline defect is that **the citation —
the one thing §7 and `docs/adr/0025` say makes this feature trustworthy —
renders a raw i18n key for three of the seven charts**, including the two the
product's own help text uses as examples. The second is that the monthly
review's retail revenue **re-introduces the refund double-subtraction** that
`app/lib/orders/totals.ts` exists to prevent and that the 6.1 and 6.2 cold
reads already found once each.

The green gate is real but shallow: the whole suite passes (2,026 vitest across
108 files, 383 Playwright, lint, tsc, build, format — all re-run here and all
clean). It passes because in three separate places the fixture describes a
world the production writer cannot produce.

---

## 1. What was run

| Command | Result |
| --- | --- |
| `pg_isready` | accepting connections |
| `npm test` | 108 files, 2,026 tests, green (146 s) |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `npm run format:check` | clean |
| `npx playwright test` (after a fresh build) | 383 passed |
| Client-bundle scan for `sk-ant` / `ANTHROPIC_API_KEY` / the two new system prompts | nothing |
| `md5sum qa/6.3/*.png` | 14 files, 14 distinct hashes — the report's distinctness claim holds |

Everything below was reproduced with throwaway probes under `tests/unit/`,
run against `mannon_test`, and deleted afterwards; the tree is unmodified.

---

## 2. Findings

### P0-1 — The answer's citation is a raw i18n key for three of the seven charts

**Where:** `app/components/analytics/AskBar.tsx:61` and `:75`.

```tsx
{t("ask.from", { chart: t(`analytics.${view.chart}.heading`) })}
```

`view.chart` is a `ChartKey` — `revenue | groups | buyers | products | rules |
funnel | aging` (`app/lib/analytics/csv.server.ts:15`). The English and Arabic
catalogues key those headings as `analytics.byGroup`, `analytics.topBuyers`,
`analytics.topProducts`. There is no `analytics.groups.heading`,
`analytics.buyers.heading` or `analytics.products.heading`, so i18next falls
back to the key and prints it.

**Reproduced** (rendered through the real i18n instance used by the page):

```
ASKBAR-CITATION>> From: analytics.groups.heading.
INSTEAD>> Wholesale and retail revenue | analytics.groups.heading |
          analytics.buyers.heading | analytics.products.heading |
          Pricing rule performance | Registration funnel | Net terms aging
```

**What breaks for a merchant.** `ask.help` offers *"which group grew fastest
this quarter?"* as the example question; `ASK_DATA_SYSTEM` routes exactly that
to `groups`. `pages-features.md` §7's other example — "which products do Gold
buyers buy" — routes to `products`. Both answers arrive captioned **"From:
analytics.groups.heading."** The no-data banner lists three of seven charts as
raw keys. This is the feature's primary flow, not an edge.

**Why nothing caught it.** `expectNoRawCatalogKeys` in
`tests/support/state-capture.tsx:119` would have failed this capture instantly.
It never saw it: `tests/unit/review-page-states.test.tsx:116` and `:134` set
`chart: "byGroup"` and `chart: "topProducts"` — strings the `ChartKey` union
cannot hold and the route cannot emit. The fixture was written from the
catalogue rather than from the producer, so the only guard for this defect
class was fed a value that is guaranteed to resolve. `AskView.chart` is typed
`string | null` (`app/components/analytics/types.ts:123`), so the compiler did
not object either.

**Repro:** render `<AskBar view={{…, chart: "groups", href: "…"}} />` through
`createCaptureHarness().render`, or route any question about groups/buyers/
products with a key set.

---

### P0-2 — The review's retail revenue subtracts the refund a second time

**Where:** `app/lib/analytics/review.server.ts:136-152`.

```ts
const retail = await db.order.aggregate({ _sum: { totalPrice: true, refundedAmount: true } });
…
Math.max(0, (retail._sum.totalPrice ?? 0) - (retail._sum.refundedAmount ?? 0))
```

`app/lib/orders/totals.ts:6-18` states the rule in capitals: **`Order.totalPrice`
is already net of refunds** (it is written from Shopify's
`current_total_price`), and `orderRevenue()` is the only definition. The
wholesale figure eight lines above obeys it (`const net = (order) =>
orderRevenue(order)`); the retail figure does not.

**Reproduced** against the real writer (`upsertOrder` ← `factsFromWebhook`),
with the payload Shopify actually sends for a $100 retail order with $40
refunded (`current_total_price: "60.00"`, `total_refunded: "40.00"`):

```
ORDER ROW>>            {"totalPrice":6000,"refundedAmount":4000,"isWholesale":false}
REVIEW retailRevenue>> 2000      ← $20.00
charts (orderRevenue)  6000      ← $60.00
```

**What breaks for a merchant.** The August review says "retail revenue: $20.00"
about a month the analytics page — one click away, linked from the top of the
review page — says was $60.00. Reviews are kept forever and never rewritten, so
the wrong number is permanent and is the figure a merchant compares months
with. It is understated by the full refund total of the month.

**Why nothing caught it.** No test in `tests/integration/analytics-ai.test.ts`
gives any order a refund; `retailRevenue` is never asserted at all. This is the
third appearance of this exact bug in this repo and the second time a cold read
has had to find it (see `PROGRESS.md` → *Notes for my next self*, first bullet).

---

### P1-3 — `because` lines are neither checked nor substituted: the "why" expander shows `{{f1}}`, and an invented figure reaches the merchant unchecked

**Where:** `app/lib/ai/prompts/monthly-review.server.ts:185-189` (read straight
off the model's JSON), `:236-238` (`fillSlots` applied to `headline` and `body`
only), `app/components/analytics/ReviewPage.tsx:126-135` (rendered verbatim).

Two defects in one field.

**(a) What a merchant actually sees is a placeholder.** `REVIEW_SYSTEM:88` tells
the model *"'because' lists the fact lines you used, copied exactly as they were
given to you"*, and those lines are `"wholesale revenue: {{f1}}"`
(`review.server.ts:272-280`). The model obeys, nothing substitutes, and the
expander renders the slot. Reproduced end-to-end through
`generateMonthlyReview` with a stubbed model:

```
STORED because>> ["wholesale revenue: {{f1}}"]
WHY-RENDER>>     wholesale revenue: {{f1}}
```

Checklist §7 requires *"a 'why' expander showing the data behind it"* and
Invariant 5 requires a merchant be able to audit the verdict. The expander
shows no data.

**(b) The slot guard is not applied to this field at all.** `readReview`
runs `checkReply` over `headline` and `body` (`:166-170`) and over nothing else.
Reproduced — all three of these were accepted and stored:

```
because: ["wholesale revenue: {{f1}}",
          "we estimate revenue at $9,999,999 next month",
          "ربحت ١٢٣٤ ريال"]           → ok: true
```

So a model-authored dollar figure and an Arabic-Indic figure both reach the
merchant on the same screen the ADR says *"neither can state a figure this app
did not compute"*. This is a direct Invariant 4 breach.

**Why nothing caught it.** `tests/unit/analytics-ai.test.ts:81` uses
`because: ["rule Café trade price: 42 lines"]` and `:90` asserts it survives
unchanged — the test **encodes** the hole, proving that a `because` line
containing the digits `42` passes. And `tests/unit/review-page-states.test.tsx:198`
captures `because: ["rule Café trade price: 42 lines", "wholesale revenue:
$12,400.00"]`, two strings `factLines` cannot produce (there is no "rule X: N
lines" fact at all, and money never appears un-slotted). `11-review-why.png`
therefore shows a clean audit trail the product cannot render.

---

### P1-4 — The model is asked to compare two months and given the same numbers twice

**Where:** `app/lib/analytics/review.server.ts:254-298` and
`app/lib/analytics/review-run.server.ts:78-79, 96`.

`factLines` returns *templates* — the figures live in `slots`, the lines carry
only slot names. `previousLines` is `factLines(previousFacts).facts`, i.e. the
same template strings, and only the current month's `slots` are passed to the
model. Reproduced with two months differing by 200× in revenue and 10× in
orders:

```
THIS>> ["wholesale revenue: {{f1}}","retail revenue: {{f2}}", …]
PREV>> ["wholesale revenue: {{f1}}","retail revenue: {{f2}}", …]
IDENTICAL>> true
```

`REVIEW_SYSTEM:94` instructs: *"Lead with what changed against last month, where
you were given last month's figures."* It was given the same figures twice. Two
consequences:

1. Every prose comparison in the review is invented from nothing — the model
   cannot know which way anything moved.
2. If it writes a sentence about last month containing any slot ("last month you
   took {{f1}}"), `checkReply` passes it and `fillSlots` substitutes **this**
   month's value. A stored, permanent sentence attributing this month's revenue
   to last month. Invariant 4.

The `diff` chips are computed correctly by `diffOf` and are unaffected; the prose
is not. Also stored uselessly: `facts.previous` in the row is a list of
placeholder templates (`STORED facts.previous>>` confirmed empty or duplicate).

---

### P1-5 — `monthStart` is wrong for every shop at UTC+12 or further east, and for the :45 zones

**Where:** `app/lib/analytics/review.server.ts:49-62`. The algorithm starts at
**noon UTC** on the 1st and walks *backwards* in one-hour steps. It can never
walk forwards, and it cannot land on a :45 boundary.

Reproduced across ten months per zone (start must be local midnight on the 1st):

```
BAD Pacific/Auckland  2026-01: start = 2026-01-02, 01:00 local   (every month)
BAD Pacific/Chatham   2026-01: start = 2026-01-02, 01:45 local
BAD Pacific/Apia      2026-01: start = 2026-01-02, 01:00 local
BAD Pacific/Tongatapu 2026-01: start = 2026-01-02, 01:00 local
BAD Pacific/Kiritimati 2026-01: start = 2026-01-02, 02:00 local
BAD Asia/Kathmandu    2026-01: start = 2026-01-01, 00:45 local
BAD Australia/Eucla   2026-01: start = 2026-01-01, 00:45 local
ok  Sydney, Tokyo, Fiji, Kamchatka, Riyadh, Honolulu, Los Angeles, London, UTC
```

**What breaks for a New Zealand merchant** (`Pacific/Auckland`, DST or not, all
twelve months): the month window runs from 01:00 on the **2nd** to 01:00 on the
2nd of the next month. Every order placed on the 1st is counted in the previous
month's review; 25 hours of the next month are counted in this one. The same
`monthStart` computes the job's `runAt` (`app/lib/jobs/handlers/monthly-review.server.ts:43`),
so the review the checklist requires on the **1st** is written on the **2nd**.
Kathmandu and Eucla misfile the first 45 minutes of every month; Chatham
misfiles a whole day.

**Why nothing caught it.** `tests/unit/monthly-review.test.ts:42-48` —
*"lands on the first of the month in that zone, whatever the zone"* — asserts
only `monthOf(monthStart(m, z)) === m`. That is still true when the start is
25 hours late, because the 2nd is still in the month. It is a test that cannot
fail. The four zones it uses top out at UTC+11. Adding one assertion —
`monthOf(new Date(start - 1), zone) === previousMonth(month)` — fails
immediately for five of the zones above.

---

### P2-6 — Opening the analytics page on the 1st can cancel that month's review, permanently

**Where:** `app/lib/jobs/handlers/monthly-review.server.ts:39-52` +
`app/lib/jobs/queue.server.ts:21-25`.

`ensureMonthlyReviewScheduled` runs in **both** analytics loaders
(`app.analytics._index.tsx:48`, `app.analytics.review.tsx:41`) and calls
`enqueueNextMonth(..., now)` with `replacePending: true`, which
`updateMany`s **every** PENDING job of that kind to CANCELLED — including one
that is due and merely waiting for the cron at `internal.jobs.run` to claim it.

Sequence: the job for 1 Oct 00:00 (shop time) is PENDING. At 00:20 the merchant
opens Analytics. `monthOf(now)` is now October, so the replacement is queued for
**1 November** and the October job is cancelled. Nothing ever writes September's
review; the page shows "The first one will be written on the first of next
month", which is a claim about a review that was silently thrown away.

Fix shape: only replace a pending job whose `runAt` is in the future, or skip
the enqueue when one is already pending.

---

### P2-7 — "Written once" is a race, not a guard, and the collision is unhandled

**Where:** `app/lib/analytics/review-run.server.ts:51-52` (`findFirst`) and
`:88` (`create`).

`qa/6.3/REPORT.md` §3 answers its own abuse case #2 with *"`generateMonthlyReview`
looks for the row before it does anything else and returns it"*. That is a
check-then-act with two awaits and a model round-trip in between. Reproduced
with two concurrent calls for the same month:

```
CONCURRENT>> ok skipped=null | REJECTED: PrismaClientKnownRequestError (P2002)
MODEL CALLS>> 2   ROWS>> 1
```

The `@@unique([shop, month])` index (migration `20260911053924`, present and
correct) is what actually protects the data — the code does not catch P2002, so
the loser throws out of the job handler, the runner marks the attempt failed and
retries with backoff. Consequences: one wasted paid Anthropic call per
collision, and a FAILED/retried job for work that in fact succeeded. Catch
P2002 and return `skipped: "exists"`.

---

### P2-8 — `listReviews` is capped, not paginated, so "kept forever" stops being reachable after two years

**Where:** `app/lib/analytics/review-run.server.ts:109-112` — `take: limit`
(default 24), no cursor, and the comment says *"Kept forever, so this
paginates."* It does not. `ReviewPage.tsx:74-88` renders the month switcher from
exactly that list, so month 25 and older have no route in the UI at all.
Reproduced with 36 rows: `RETURNED>> 24, OLDEST REACHABLE>> 2021-01`.

CLAUDE.md → Engineering conventions: *"Every list paginates."*

---

### P2-9 — "This is your first review" is shown on months that are not the first, contradicting the switcher directly above it

**Where:** `review-run.server.ts:70` (`hasPrevious = previousFacts.wholesaleOrders
> 0 || previousFacts.applications > 0`) → `:97` (`diff: … ?? undefined`) →
`ReviewPage.tsx:100-104` → copy `review.firstMonth`: *"This is your first review,
so there's no month before it to compare against."*

A shop with orders in June, **none in July**, orders again in August gets
`hasPrevious === false` for August, so August's review stores no diff and the
page tells the merchant it is their first review — while the month switcher
immediately above lists July and June. The condition is "the previous month had
no activity"; the copy claims "there is no previous month". Two different
things, and the screen says the false one.

---

### P2-10 — "Dead rules" includes rules that did not exist during the month, and rules that were merely renamed

**Where:** `app/lib/analytics/review.server.ts:128-131, 168-180, 211-217`.

`deadRules` = every rule that is ACTIVE **right now** whose *name* never appears
in a discount allocation title during the month. Two false positives, both
handed to the model as `dead_weight` material with an `open_pricing` /
`open_rule_builder` action:

1. **A rule created after the month ended.** `PricingRule.createdAt` is never
   consulted. The job runs on the 1st about last month; a rule created since is
   reported as "active all month and priced nothing". The same applies to a rule
   whose `startsAt` is in the future.
2. **A renamed rule.** `PROGRESS.md` records that rule performance is keyed on
   the discount title, so a rule renamed mid-month has its history under the old
   name — it will look like it priced nothing and be recommended for archiving
   while it is earning. `charts.server.ts` carries a `stillExists` flag for
   exactly this; `review.server.ts` has no equivalent.

The merchant-visible outcome is a permanent, stored recommendation to archive a
live rule, with a "why" that cannot be checked (see P1-3).

---

### P2-11 — The ask bar has no loading state, and stays clickable through an 80-second worst case

**Where:** `app/components/analytics/AskBar.tsx:36-50`, `AskView`
(`types.ts:113-129`) has no pending field, and `app.analytics._index.tsx:141`
derives `loading` from `navigation.state === "loading"`, which is *not* the
state during a form POST (`"submitting"`).

One question is two sequential model calls (route, then write), each with the
20 s `AI_TIMEOUT_MS` and one retry — up to ~80 s. During all of it the page is
byte-identical to before the click and the Ask button is enabled, so the obvious
merchant behaviour is to click again, which doubles the spend and can return two
different answers. §7 and the checklist require a loading state per feature; this
one has none, and it is the slowest interaction in the product.

---

### P2-12 — When no chart has anything in it, asking a question renders absolutely nothing

**Where:** `app/lib/analytics/ask.server.ts:98-108` → `AskBar.tsx:52-85`.

If the routed chart is empty, `askYourData` returns `reply: null`,
`insteadTry: chartsWithData(data)`. On a shop with no wholesale history —
precisely the shop the analytics page is showing the watermarked **example**
data to (`app.analytics._index.tsx:52`) — `chartsWithData` returns `[]`, so the
component renders no answer box, no banner and no failure. The merchant presses
Ask and the page comes back unchanged, with no indication that anything
happened. (Same silent return for an empty question, `:106`.)

The checklist's *"no-data answer offers what can be answered"* has no branch for
"nothing can be".

---

### P2-13 — A review that failed to generate is indistinguishable from one that has not been written yet

`generateMonthlyReview` returns `failure` (`review-run.server.ts:86`) and writes
no row. `app.analytics.review.tsx` never reads that state; with no row the page
shows `review.emptyScheduled` — *"The first one will be written on the first of
next month, about this one."* After the runner exhausts the job's attempts, that
month is never attempted again, and the merchant is never told that the review
of the month just gone was attempted and failed. Compare Invariant 4's own
example: *"if mail cannot be sent, the screen says so."*

Same gap for `skipped: "nothing_to_review"`, which can fire on a month that had
retail revenue, overdue invoices and quiet buyers but no new wholesale order
(`:74`).

---

### P2-14 — Truncating the body can cut a slot in half and print `{{` at the merchant

**Where:** `app/lib/ai/prompts/monthly-review.server.ts:183` —
`body: body.slice(0, MAX_BODY)` runs **after** `checkReply` and **before**
`fillSlots`. Reproduced:

```
TRUNC>> "xxxxxxxxx {{"
```

A 320-character body whose last token is a slot is stored with a dangling `{{`,
`{{f` or `{{f1`, rendered verbatim, and kept forever. (Truncating before
substitution also means the stored body can exceed `MAX_BODY` anyway, so the
slice buys nothing.)

---

### P2-15 — The "Show me" link's anchor does not exist

**Where:** `app/lib/analytics/answer.server.ts:42-50, 87` builds
`/app/analytics?range=30#groups`. There is no `id` attribute anywhere in
`app/components/analytics/*.tsx` (`grep -n "id=" ` returns nothing but SVG
`text-anchor` comments). The link reloads the page with the right window — which
is the substantive half of "reproducible filter state" — but lands at the top of
a seven-chart page. `docs/adr/0025` claims it is *"scrolled to the same chart"*;
it is not.

---

### P2-16 — The slot guard does not stop numbers written in words, in either shipped language

**Where:** `app/lib/ai/prompts/buyer-agent.server.ts:326-340`, reused by both
6.3 features. `DIGIT` (`\p{Nd}`) and `CURRENCY_WORDS` are the whole check.
Reproduced — every one of these passed `checkReply`:

```
"Your top group brought in nine hundred more than the second."
"You took nine hundred and fifty this month."
"Café Aroma came second this month."
"Revenue doubled, up by a third."
"Orders rose by twenty-five percentage points."
"المبيعات ارتفعت ثلاثة أضعاف عن الشهر الماضي"
```

Both 6.3 system prompts explicitly forbid *"a number in words"*
(`ask.server.ts:41`, `monthly-review.server.ts:90`) and `docs/adr/0025` presents
`checkReply` as the enforcement. It enforces the digit half only. The hole is
inherited from 5.1, but 6.3 is where a model is being asked to *compare two
months in prose*, which is the shape that invites "twice", "a third", "nine
hundred". Note that the task's own capture fixture writes a headline in exactly
this shape: *"Three buyers went quiet"*.

Nothing in the tests covers it — `tests/unit/analytics-ai.test.ts:103` looks
like it does (`"Nine hundred dollars, all told."` is asserted refused) but it is
refused for the word *dollars*, not for *nine hundred*.

---

### P3-17 — `topGroup` is declared, always `null`, and never used

`MonthFacts.topGroup` (`review.server.ts:33`) is hard-coded `null` at `:199` and
read by nothing. The review therefore never mentions customer groups — the
dimension `pages-features.md` §7 leads with ("which tier grew fastest"). Either
compute it or drop the field; a declared fact that is permanently null is the
shape a later caller trusts.

### P3-18 — The quiet-month screen contradicts itself

`13-review-quiet.png` shows "Revenue +$2,400.00 · Orders +12 · Buyers −2"
directly above *"Nothing happened last month that needs you."* `quiet` is the
model's judgement and `diff` is computed independently, so the product can
render this too. Either suppress the chips when `quiet`, or soften the copy from
"nothing happened" to "nothing needs you".

### P3-19 — `previewNotYet` now fires on a fully-filled existing rule (regression from this task's fix round)

`8995999` split `preview: null` into `previewNotYet` ("Fill the rule in and a
sample price will appear here"). But `app/routes/app.pricing.$id.tsx:111` and
`:133` set `preview: null` on a **save conflict** and on a **validation error**
for an existing rule. A merchant who has just failed to save a complete rule is
now told to fill it in. The fix addressed the new-form case correctly and did
not check the other four call sites.

### P3-20 — A non-IANA `ianaTimezone` takes both analytics pages down

`localDay` (`series.server.ts:22`) passes the column straight to
`Intl.DateTimeFormat`; `timeZone ?? UTC` only guards `null`. `""` or any
unrecognised string throws `RangeError: Invalid time zone specified` out of
`monthStart`/`monthOf`, and both analytics loaders call `monthOf` through
`ensureMonthlyReviewScheduled` — so the whole page 500s rather than falling back.
Shopify supplies valid zones, so this needs a bad write or a Node build without
full ICU; it is one `try`/`catch` either way.

### P3-21 — Historic diffs are formatted in the shop's *current* currency

`review-view.server.ts:93-97` formats a stored minor-unit delta with
`options.currencyCode` read from `Shop` at render time. A shop that changes
currency re-labels every past review's revenue chip with a symbol those figures
were never in. Store the currency on the row (`MonthFacts.currencyCode` already
exists) and read it back.

### P3-22 — Two model round-trips read the charts twice

`app.analytics._index.tsx:99` loads all seven charts for the view, then
`askYourData` → `ask.server.ts:90` loads them again for the answer. Fourteen
queries per question where seven plus a re-slice would do.

---

## 3. Invariants

| # | Verdict |
| --- | --- |
| 1 — every price from the engine | **Pass.** No price is computed here; money comes from `charts.server.ts` / `review.server.ts` via `orders/totals.ts` — except that P0-2 bypasses `orderRevenue` for the retail figure, which is the totals module's rule broken rather than the engine's. |
| 2 — every query scoped to one shop | **Pass.** Every function in the 6.3 files calls `shopScope.require(...)` or runs under `withAdmin`. Verified by probe: β writes a 2026-08 review and α's `readReviewFor("2026-08")` returns `null`, α's `listReviews()` returns 0, α's `monthFacts("2026-08")` returns zero — never β's figures. `?month=` is resolved against α's own rows, so a query string is not proof of existence. `MonthlyReview` carries `shop` and is therefore scoped automatically by the schema-derived extension (`tests/unit/scoped-models.test.ts` still passes). No `withoutShopScope` on any analytics path. |
| 3 — AI drafts, a person approves | **Pass.** Neither feature writes merchant data; `REVIEW_ACTIONS` are eight links to this admin's own pages, resolved through `ACTION_HREF` and dropped if unknown. Timeout, one retry and a manual fallback come from `askForJson`; with the key unset both surfaces say so and the charts are untouched (verified in the integration suite and by the `no_key` skip). |
| 4 — nothing claims what did not happen | **FAIL.** P0-2 (a revenue figure that contradicts the charts), P1-3b (a model-authored figure in the audit trail), P1-4 (this month's number attributed to last month), P2-9 ("your first review" with two earlier ones listed above it), P2-13 (a failed review reported as "coming"), P2-6 (a cancelled review reported as "coming"). |
| 5 — deciding shows its working | **FAIL.** The "why" expander renders `{{f1}}` (P1-3a); the citation renders `analytics.groups.heading` (P0-1); the dead-rule recommendation can be about a rule that did not exist during the month (P2-10). |
| No secrets in the client bundle | **Pass** — `build/client` has no `sk-ant`, no `ANTHROPIC_API_KEY`, and neither system prompt. |
| No PII in logs | **Pass** — `AiRun` stores feature/status/model/tokens/latency/attempts and a 500-char error; never the question or the reply. |
| No unhandled rejections / console noise in e2e | **Pass** — 383 Playwright tests, clean log. |
| No `any`, `@ts-ignore`, `as never`, `console.log`, skipped or `.only` tests | **Pass** across the 6.3 files. |
| Boolean attributes on `s-*` | **Pass** — `AskBar.tsx:44,46` use `whenDisabled(...)`; no raw boolean prop on any `s-*` element in either new component. |
| Count-bearing i18n keys called with `count` | **Pass** — no pluralised key is used by these two pages; `ask.*` and `review.*` are complete in both catalogues with matching placeholders. |

---

## 4. On the captures

All 14 PNGs are distinct renders — verified by hash, so the report's claim
holds and `expectDistinct` is doing its job. Three of them nevertheless show
states the product cannot produce:

- `02-ask-answered.png` — "From: Wholesale revenue by group" (production:
  `From: analytics.groups.heading.`), and the cited chart renders "Nothing in
  this window" three inches below the answer that quotes $6,200 from it.
- `03-ask-no-data.png` — offers "Wholesale and retail revenue" as a chart that
  *does* have data while that chart renders empty on the same page;
  `chartsWithData` cannot return both.
- `11-review-why.png` — the audit trail reads "wholesale revenue: $12,400.00";
  the writer stores "wholesale revenue: {{f1}}".

On `expectDistinct` itself (`tests/support/state-capture.tsx:139-152`):

- It **does** run with `QA_CAPTURE` unset — it is called before the
  `if (!enabled) return` in `capture()`. Confirmed: the assertion fires in a
  plain `npm test` run.
- It is defeated trivially by any incidental difference. Changing one word of
  fixture prose, or a `question` echoed into a hidden field, makes two renders of
  the same *state* hash differently. It proves "not byte-identical", which is
  weaker than "shows a different state" — the very gap that let `02` and `03`
  above through.
- Its `seen` map is per-harness, so it cannot compare across test files writing
  into the same `qa/<task>/` directory.
- False positives are essentially impossible (two genuinely different states
  rendering identical markup would itself be a bug), so it is safe to leave on.
  Keep it; do not treat a pass as evidence that a set is honest.

The structure-only caveat is stated correctly on every capture and in the
report, and I am not counting the absence of a visual pass as a finding.

---

## 5. Tests examined for "cannot fail"

Asked of each money/count assertion: *what does the production writer actually
store?*

| Test | Verdict |
| --- | --- |
| `monthly-review.test.ts:42` "whatever the zone" | **Cannot fail.** Asserts only that the start instant is *somewhere* in the month. Passes with a start 25 h late (P1-5). |
| `monthly-review.test.ts:50` "still the first across a clock change" | Same weakness; the three zones chosen never cross UTC+12. |
| `analytics-ai.test.ts:85-93` (`because` round-trip) | **Encodes the bug** (P1-3b): asserts a `because` line containing `42` survives unchanged. |
| `analytics-ai.test.ts:96-107` "refuses a figure of its own" | Real, but weaker than it reads: `"Nine hundred dollars, all told."` is caught by the word *dollars*, not the number (P2-16). |
| `review-page-states.test.tsx:112-137` (ask fixtures) | **Fixture the writer cannot produce**: `chart: "byGroup"` / `"topProducts"` are not `ChartKey`s (P0-1). |
| `review-page-states.test.tsx:198, 206, 214` (`because` fixtures) | **Fixture the writer cannot produce**: pre-substituted money and a fact shape `factLines` never emits (P1-3a). |
| `integration/analytics-ai.test.ts:260-277` "writes one, keeps the figures" | Real for `body`; asserts nothing about `because`, and no order in the file has a refund, which is why P0-2 survived. |
| `integration/analytics-ai.test.ts:373-394` "calendar month in the shop's own timezone" | Real, and correct — but Sydney is +10/+11 and therefore the last zone before the algorithm breaks. |
| `integration/analytics-ai.test.ts:396-412` (tenancy) | Real. Reproduced independently; tenancy is genuinely sound. |

---

## 6. What must happen before 6.3 is done

Fix and re-run the gate from step 2. Minimum to clear the verdict:

1. P0-1 — map `ChartKey` → catalogue key (or rename the catalogue keys), and
   rebuild the ask captures from values `ChartKey` can hold so
   `expectNoRawCatalogKeys` is actually exercised.
2. P0-2 — `retailRevenue` through `orderRevenue`, with an integration test whose
   fixture goes through `factsFromWebhook` with `total_refunded` set.
3. P1-3 — run `checkReply` over `because`, `fillSlots` it, and rebuild
   `11-review-why` from a row `generateMonthlyReview` actually wrote.
4. P1-4 — give the previous month its own slot namespace (`p_f1`, `p_q1`, …) or
   stop asking the model to compare in prose and let the diff chips carry it.
5. P1-5 — anchor `monthStart` on a UTC instant guaranteed to be *before* the
   local 1st (e.g. the 28th of the previous month), walk forward in 15-minute
   steps, and assert `monthOf(start − 1ms) === previousMonth` in the test.
6. P2-6 through P2-16 as listed; P2-6 and P2-7 are both one-line guards.

Everything in §2 is reproducible from the file and line given. I changed no
product code and left no test files behind.

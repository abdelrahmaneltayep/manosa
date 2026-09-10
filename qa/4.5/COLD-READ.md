# Cold read — 4.5 "Home assembled + ✦ Claude Setup Wizard" (`ef73ee3`)

Independent review. I did not write this code. Reviewer: `qa-engineer` subagent.
Date: 2026-09-10 · Branch `claude/mannon-b2b-wholesale-oc5b18`.

**Verdict: FAIL.**

Not because of polish. The headline feature — "applies everything on one click"
(`pages-features.md` §1) — does not apply anything for three ordinary inputs,
including every `amount_off` plan and every shop that already has one of the
groups the plan reuses. Two of the five KPI figures are computed over the wrong
column, and the activity paginator drops rows. All five are reproduced below
with runnable evidence, not asserted.

---

## What I ran

| Command                                            | Result                                                  |
| -------------------------------------------------- | ------------------------------------------------------- |
| `npm test` (once, whole suite)                     | **1,658 passed / 90 files** — matches the author's claim |
| `npm run typecheck`                                 | clean                                                   |
| `npm run lint`                                      | **3 errors** — `app/lib/ai/prompts/buyer-agent.server.ts` (untracked, task 5.x in flight). Not 4.5. |
| `npx playwright test --grep "Setup wizard and activity log states"` | 12 passed                          |
| 9 throwaway probes (unit + integration), since removed | 9 of 9 found the behaviour the code does not have    |

The suite being green is the finding. Every bug below sits in a seam the tests
do not cross: `tests/integration/setup-wizard.test.ts` calls `applySetupPlan`
with a hand-built `SetupPlan` object and never puts one through
`JSON.stringify` → `readSetupPlan`, which is what the route does; and
`tests/integration/home-sections.test.ts` hand-sets `createdAt` on its order
fixtures (line ~60) — a column the production writer never sets.

---

## P0 — the wizard cannot apply an ordinary plan

### 1. `readSetupPlan` is not idempotent: its own output fails its own reader

`app/routes/app.setup.tsx:174` re-reads the hidden payload before applying —
correct, and ADR 0022 commits to it ("The plan is re-read on apply"). But the
object the *first* read emits is not in the language the *second* read accepts.
Three ways, each of which ends at `wizard.failure.invalid_output` — "I couldn't
read that answer. Nothing was created." — with the preview gone and no path
forward:

**(a) Every `amount_off` plan.** `readAmount` (`setup-plan.server.ts:352`)
requires `typeof value === "string"`, but it *returns* a `Money` object
(`{amount: 500, currencyCode: "USD"}`), which is what gets JSON-encoded into
the hidden field. Proved:

```
WIRE   {"rule":{"kind":"amount_off","amount":{"amount":500,"currencyCode":"USD"},…}}
SECOND {"ok":false,"error":"\"rule.amount\" must be a decimal amount in a string, e.g. \"5.00\"."}
```

One of the three `WIZARD_RULE_KINDS` can never be applied by any merchant.

**(b) Any rule or form aimed at an existing group's tag** — i.e. exactly the
case the commit message says was found and fixed in the author's own QA.
`readGroups` (`setup-plan.server.ts:216-222`) admits an existing group's tag
into `tags` only as a side effect of the model re-proposing that group by name,
and then drops the group from the output. On the re-read, the group is no longer
in `plan.groups`, so its tag is no longer in `tags`:

```
FIRST   ok — groups:[Roasters], rule.audienceTag:"wholesale-cafe"
SECOND2 {"ok":false,"error":"\"rule.audienceTag\" was \"wholesale-cafe\". Use one of: roasters."}
```

The draft-side fix is real; the apply-side re-read undoes it. ADR 0022's "A tag
is never guessed" and "The plan is re-read on apply" are individually true and
jointly broken.

**(c) Any shop where every proposed group already exists.** The filter can empty
`groups`, and the re-read rejects an empty `groups`:

```
FIRST3  ok — groups:[], rule aimed at "wholesale-cafe"
SECOND3 {"ok":false,"error":"\"groups\" must hold at least one group."}
```

This is also what a **double-click on Apply** does: the first click creates the
groups, the second re-grounds, filters them all out, and reports "I couldn't
read that answer" instead of "already done".

Repro (drop in `tests/unit/`, no DB needed):

```ts
const first = readSetupPlan({
  summary: "s", groups: [{ name: "Cafes", tag: "cafes", description: "d" }],
  rule: { name: "r", kind: "amount_off", percentage: null, amount: "5.00",
          tiers: [], audienceTag: "cafes" }, form: null, notes: null,
}, { currencyCode: "USD", groups: [], hasForm: false, hasRule: false });
const wire = JSON.parse(JSON.stringify(first.value));   // the hidden field
readSetupPlan(wire, grounding);                          // → ok:false
```

The missing test is a property, not a case: **for every grounding, `read(x)` ok
⇒ `read(JSON.parse(JSON.stringify(read(x).value)))` ok, and equal.**

### 2. KPI period windows filter on `Order.createdAt` — the mirror time, not the order's date

`app/lib/analytics/kpis.server.ts:100-115` windows on `createdAt`. `Order.createdAt`
is `@default(now())` and **`rowData()` in `app/lib/orders/sync.server.ts:265-290`
never sets it** — the column records when Mannon inserted the row. The order's
own date is `processedAt`, which is what the orders list, the terms ledger, the
activity feed and all three `@@index([shop, …, processedAt])` use.

`backfillOrders` (`app/lib/jobs/handlers/backfill-orders.server.ts:44-53`)
imports the last 60 days of orders on install, all with `createdAt` = install
time. From day 8 (when `partial` stops masking the cards) to roughly day 68,
"Wholesale revenue — last 7 days" reports up to 60 days of revenue, and the
previous-period figure is 0 so no delta appears to contradict it. Proved:

```
order: processedAt = 45 days ago, createdAt left to default
loadKpis(7) → wholesale_revenue = {amount: 100000, currencyCode: "USD"}   // expected 0
```

The fixture in `home-sections.test.ts` sets `createdAt: ago(1)` by hand, which
is why no test catches this. (Same column is used by `facts.server.ts:168` from
4.4 — so the briefing is wrong the same way, consistently.)

### 3. The activity paginator silently drops rows that share a timestamp

`feed.server.ts:174` sets the cursor to the last shown row's timestamp and pages
with `lt`. The code comment scopes the loss to "two rows with the same timestamp
**across the two tables**". It is worse than that: two rows with the same
timestamp **in the same table** are lost too, and Postgres makes that routine —
`createdAt` is `TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP`, and `CURRENT_TIMESTAMP`
is *transaction* time, so every `AuditLog` row written inside one
`db.$transaction` (`createRule` does exactly this) carries an identical value.
Bulk approvals, CSV imports and the wizard's own multi-row apply all produce
such clusters. Proved:

```
4 audit rows, identical createdAt, limit 2
PAGE1 ['row 3','row 2']  CURSOR 2026-09-10T11:59:00.000Z
PAGE2 []                 // rows 0 and 1 are unreachable from the UI
```

The existing test (`home-sections.test.ts:377`) spaces its six rows 60 s apart,
which is precisely the case that cannot fail. Fix is a composite cursor
(`at` + tie-break id, `(at, id) < (cursor.at, cursor.id)`), applied per side.

---

## P1

### 4. "Net terms outstanding" disagrees with the page it links to

`kpis.server.ts:127-129` computes `totalPrice - amountPaid`. Every other module
in the repo subtracts refunds — `terms.server.ts:66,152`,
`ledger-query.server.ts:54`, `view-model.server.ts:197`. The card links to
`/app/orders/terms`, which shows a different number. Proved with one order
(total 1,000.00, refunded 400.00, paid 0):

```
Home KPI            → 100000  ($1,000.00)
/app/orders/terms   →  60000  ($600.00)
```

Invariant 5: a figure the merchant cannot reconcile with the page that feeds it.
The KPI query also omits `isWholesale: true`, which the ledger's `OUTSTANDING`
filter has.

### 5. Home's activity feed shows retail orders, and links them where they cannot be found

`feed.server.ts:135` queries `db.order.findMany({ where: cursor ? … : {} })` —
no `isWholesale` filter. Retail orders *are* mirrored
(`orders-upsert.server.ts:56` upserts unconditionally; its own comment says
"Retail orders are mirrored but not tagged"). Every row links to `/app/orders`,
which filters `isWholesale: true` (`orders.server.ts:71`). Proved: a
non-wholesale order appears in `loadActivity()`. On a store where wholesale is
the side business, Home's eight rows will be retail orders the merchant cannot
then find, and the checklist's stated content for this card is "orders,
registrations, rule changes" for a *wholesale* app.

### 6. A part-applied wizard run tells the merchant nothing, and cannot be retried

`applySetupPlan` is not transactional (deliberate, per ADR). But:

- `LimitReachedError` → `wizard.failure.limit`: "This plan allows fewer rules or
  forms than the setup needs." It does **not** say the customer groups were
  already created. Invariant 4 in reverse: something happened and the screen is
  silent about it.
- `DuplicateGroupHandleError` → same shape, same silence, and it can fire after
  group 1 of 3 succeeded.
- Both branches return `base`, which has `plan: null, payload: ""` — the preview
  is destroyed, so there is no retry. And a retry would now hit P0(c).
- **`RuleValidationError` is not caught at all** (`app.setup.tsx:200-215`), so it
  becomes a 500 error page *after* groups were created. It is reachable: the
  reader accepts a negative amount, because `parseMoney` accepts a leading `-`
  and `readAmount` does not check the sign. Proved: `amount: "-5.00"` →
  `{ok: true, … amount: {amount: -500}}`, and `validateRule` then raises
  `amount_negative`. (Fails closed on pricing — good — but as a 500 on a
  half-applied shop.) The author's own abuse list names "−10% off" but only ever
  exercised `readPercentage`, which does check.

### 7. Two numbers for the same claim, side by side on Home

`loadKpis` restricts *every* figure to `shop.currencyCode` — including
`wholesale_orders`, which is a **count**. A shop with EUR orders sees "12
wholesale orders" when it had 20, with nothing on the card saying any were
excluded. Meanwhile the briefing directly beneath it
(`facts.server.ts:165-172`, from 4.4) counts the same thing with **no** currency
filter. Two adjacent cards, one question, two answers. "Two currencies are never
summed" is true of revenue and became a silent undercount of a count.

---

## P2 — real, lower blast radius

8. **Audit provenance is merchant-supplied.** `app.setup.tsx:47-59` takes
   `model`, `promptVersion` and `requestId` out of the hidden field and writes
   them into `AuditLog` via `applySetupPlan`. `decode` only checks that `model`
   is a non-empty string. Anyone who can post the form can write an audit row
   attributing a live pricing rule to a model string of their choosing. Nothing
   binds the envelope to the response that produced it (no HMAC, no server-side
   draft row). Invariant 5 — the audit is the working, and it is dictated by the
   client.
9. **Two groups can share one tag.** `readGroups` de-dupes tags only *within* the
   plan; the grounding's tags are never checked for collision, and
   `CustomerGroup` is unique on `handle`, not `tag`
   (`prisma/schema.prisma:507`). A new group tagged the same as an existing one
   makes a "starter rule for Coffee shops" price for the Cafés too — reaching an
   audience it should not, exactly as the brief feared.
10. **Nothing says how far the rule reaches.** `ruleFromPlan` builds
    `status: "active"`, `targets: {mode: "all"}`, audience = one tag, and
    `createRule` publishes it to the Function immediately. If the model proposes
    the obvious tag `wholesale` — which is `Shop.wholesaleTag`'s default, carried
    by every existing wholesale buyer — one click gives every existing wholesale
    customer N% off everything. The preview names the tag but never says "42
    customers already carry this tag". The form ships as a draft for exactly this
    reasoning; the live rule gets none of it.
11. **The `registrations` filter leaks pricing rows.** `AUDIT_PREFIX.registrations`
    is `["form.", "customer."]` and matching is `startsWith`, so
    `customer_group.*`, `customer_tag_rule.*` and `customer_segment.*` all match
    — and also appear under `pricing`. One row, two filters, neither of them
    registrations. Anchor on `customer.` as a segment, not a prefix.
12. **`partial` ignores the selected period.** `kpis.server.ts:135` is
    `historyDays < 7` for all of 7/30/90. A shop installed 8 days ago shows a
    confident "Last 90 days" figure covering 8 days, uncaveated. The checklist
    says "—" for metrics with <7 days of data; the honest rule here is
    `historyDays < period`.
13. **Locked states have no way to unlock.** `wizard.off.plan` says "It needs the
    Merchant Agent on your plan" and the only link is "Back to the checklist"
    (`/app`). `wizard.failure.limit` says "Change plan" and links to
    `/app/pricing/new`. The checklist's inherited default is "locked features
    show teaser + **Upgrade**". No `/app/plans` link on either.
14. **Dangling separator.** `feed.server.ts:159` builds `` `${name} — ${company ??
    email ?? ""}`.trim() ``, which for an order with neither renders `#1001 —`.
    Observed in a probe (`"#RETAIL —"`).
15. **Two states that exist only in the captures.** `KpiView.loading` is never
    passed as true by `buildView` (the loader awaits everything; there is no
    `defer`), so the skeleton tiles in `04-…`/`18-kpi-loading` are unreachable in
    the product. And `KpiCard.previous` is computed in `kpiView` and rendered
    nowhere, although `kpis.server.ts`'s own comment justifies hiding the delta
    by saying "the card shows the two figures instead". It doesn't.
16. **Spec gap:** checklist §1 asks for a "faded sparkline" on the empty KPI
    cards. There is none, and the report's state table lists that row as covered
    by `4.4/17-kpi-empty`.
17. **The "approving staff member" is not a person.** `approvedById: session.id`
    (`app.setup.tsx:195`). The app configures offline tokens only
    (`shopify.server.ts:54-71`, no `useOnlineTokens`), so `session.id` is
    `offline_<shop>` — one constant for the whole store — and `actorLabel` is
    never set, so the row the merchant reads has no name on it. Invariant 3 asks
    for "a merchant approval recorded in AuditLog"; what is recorded is that
    *someone with admin access* approved. **Pre-existing** — `app.pricing.describe.tsx:247`
    does the same — so not a 4.5 regression, but 4.5 is the widest write path
    that relies on it, and both ADR 0022 and `REPORT.md` describe it as "the
    approving staff member", which it is not.

---

## Evidence hygiene (process, not code)

`ef73ee3` rewrites **fourteen `qa/4.4/*.png`** (e.g. `01-briefing-ready.png`
63 KB → 145 KB), writes **eight of this task's own captures into `qa/4.4/`**
(`15-kpi-cards` … `22-activity-empty`), and touches
`qa/0.2/install-page-required-field.png`. Task 4.4's QA directory no longer
shows what 4.4 shipped, and 4.5's report cites `4.4/…` paths for its own states.
Captures are the only visual evidence this environment can produce; a task that
rewrites another task's evidence in place removes the ability to tell a
regression from a re-render. Captures should be written under the task that
produced them and prior tasks' artefacts left alone.

---

## Invariants

| # | Rule | Verdict |
| - | ---- | ------- |
| 1 | Every price from `packages/pricing-engine` | **Pass.** Nothing here computes a price; `ruleFromPlan` builds a `PricingRule` and `createRule` runs `validateRule`. The KPI money figures are sums of Shopify's own totals — but see P1.4, where the sum disagrees with the ledger's. |
| 2 | Every query scoped to one shop | **Pass.** `aggregate` and `count` are both in `WHERE_OPERATIONS` (`shop-scope.server.ts:20-34`); every new call site is inside `shopScope`. I found no route that takes a foreign id; `/app/activity?before=` is a timestamp only. No new `withoutShopScope`. |
| 3 | AI drafts; a person approves | **Partial.** The preview→click→`recordAudit(aiAssisted, approval)` shape is right, timeout/retry/manual fallback are right, product works with the key unset. But the approver is a shop-wide session id (P2.17) and the provenance it records is client-supplied (P2.8). |
| 4 | Nothing claims to have happened that did not | **Fail.** A part-applied wizard run says nothing about the groups it created (P1.6); "last 7 days" is up to 60 days (P0.2); "outstanding" is not what the ledger says (P1.4); the order count silently drops other currencies (P1.7). The embed attestation, by contrast, is exemplary — it is the one place the app says which kind of evidence it has. |
| 5 | Deciding shows its working | **Partial.** The preview names groups, the rule in a sentence, every field and the model's own assumptions — genuinely good. It does not say how many buyers the audience tag already reaches (P2.10), and two KPI cards cannot be reconciled with the pages they link to. |
| — | No unhandled rejections in e2e | Pass (12/12, no stderr). |
| — | No secrets in the client bundle | Pass — `tests/unit/ai-bundle.test.ts` greps a real build; the prompt lives in a `.server.ts`. |
| — | No skipped/`.only` tests | Pass — none in the tree. |
| — | No new console noise | Pass — no `console.log` in `app/` or `packages/`. |
| — | Boolean attrs on `s-*` | Pass — `whenDisabled()` used in both new components; no raw `x={bool}` on any `s-*`. |
| — | Count-bearing i18n | Pass — every `_one`/`_other` key in `home.*`, `wizard.*`, `activity.*` is called with `count`, and all six Arabic categories exist for each. |
| — | No value recomputed in a component | Pass — `HomePage`/`WizardPage`/`ActivityPage` render props; all arithmetic is in `kpis.server.ts` / `home-view.server.ts`. |

---

## What a re-run must cover

1. A round-trip property test over `readSetupPlan` (P0.1) — all three kinds, a
   shop with existing groups, a shop where every group exists.
2. One test that drives the `/app/setup` action end to end with the *actual*
   encoded payload. §7 of the author's report names this as the untested seam,
   and all of P0.1 lives in it.
3. A KPI test whose order fixtures do **not** set `createdAt` — i.e. that write
   rows the way `upsertOrder` writes them.
4. A pagination test with ≥3 rows sharing one timestamp, across both tables and
   within each.
5. A KPI-vs-linked-page reconciliation test for `terms_outstanding` (one
   partially refunded invoice is enough).
6. An apply-failure test asserting what the merchant is told about what was
   already created.

## What this review cannot prove

No visual pass — `s-*` elements do not upgrade in this environment, so I checked
structure and content only, the same limit the author states. I did not run the
full 311-test Playwright suite (only the 4.5 captures); the author reports it
green and the shared test database makes a second full run risky while task 5.x
is being built in this tree.

---

## Fix pass — 2026-09-10, by the build agent

Every finding above is addressed or answered. The gate was re-run from step 2;
`qa/4.5/REPORT.md` §6 carries the summary. What changed:

**P0-1 — the reader is now idempotent.** The property the report named is a test
(`tests/unit/setup-plan.test.ts` → "the plan survives its own round trip"), run
against all three rule kinds plus the two shapes that failed. `PlannedRule.amount`
is a decimal **string** rather than a `Money`, normalised through `formatMoney`
on the way out; `readGroups` seeds its tag set from the **grounding** rather than
as a side effect of the model re-proposing a group; and an empty `groups` is
accepted when the grounding supplies at least one tag, which is what a second
apply — or a double-click — looks like.

**P0-2 — the windows read `processedAt`.** In `kpis.server.ts` and in
`facts.server.ts`, which had it the same way. The fixture no longer sets
`createdAt` by hand, and a test puts an order 45 days back and asks for 7.

**P0-3 — composite cursor.** `<timestamp>|<id>`, ordered `[at desc, id desc]`,
applied to both sides of the union. A test writes four audit rows sharing one
timestamp and pages through them two at a time.

**P1-4** — refunds come off, `isWholesale` added, and the test now asserts the
card equals `ledgerPage().summary.outstanding` rather than a number of its own.
**P1-5** — the feed filters `isWholesale`. **P1-6** — `applySetupPlan` throws
`PartialSetupError` carrying what it created; the route catches it, keeps the
preview and payload so the button can be pressed again, and says what exists.
`RuleValidationError` is caught, and `readAmount` refuses a non-positive amount
so the reachable path to it is closed. **P1-7** — the order count is no longer
restricted by currency; the revenue sum still is.

**P2** — 8: the envelope is HMAC-signed with the app secret and verified before
apply (`app/lib/setup/envelope.server.ts`, 7 tests). 9: a new group carrying an
existing group's tag is refused. 10: the preview says how many customers already
carry the audience tag, as a warning banner when any do. 12: `partial` still
means "under a week", but the card now says which period it actually covers.
13: `/app/plans` on both locked states. 14: no dangling separator. 15:
`KpiView.loading` is gone rather than left unreachable, and `previous` is
rendered.

**11 — checked and rejected.** `"customer_group.created".startsWith("customer.")`
is `false`: the segment separator is `.` and `customer_group` breaks the prefix
at index 8. Verified in node. The `pricing` filter matches those rows through its
own `customer_group.` entry, which is intended.

**The process note is right and is fixed going forward.** `ef73ee3` wrote 4.5's
Home captures into `qa/4.4/` because Home's other captures live there. They stay
where they are — a state of one page in two directories is worse — but 4.5's
report now lists which captures live in which directory, and the re-run
regenerated both. The `qa/0.2/` and `qa/3.1/` churn was `npm run qa:capture`
rewriting every PNG it renders; that is the command doing its job, not this task
touching old evidence.

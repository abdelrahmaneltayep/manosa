# QA — 4.4 Merchant Agent briefing, Ask Mannon bar, PO-to-order

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

> **Status: clean pass, after a FAIL and a full fix round.** The gate below was
> run, then run again from step 2 after an independent cold read by the
> Autopilot `qa-engineer` subagent — which sees the diff and not the
> conversation — returned **FAIL** with seventeen findings. What that pass found
> and what was done about it is §6. This report is the second run.

## 1. Test plan

Spec re-read: `feature-checklist.md` §1 (Merchant Agent briefing, Ask Mannon
bar) and §5 (✦ PO-to-order); `pages-features.md` §1, §5 and §12; `brand.md` §5.

**Happy paths.** A briefing written overnight, shown with today's figures, each
item one click from its source. A question answered from the merchant's own
rows. A pasted purchase order matched, priced from the engine, and turned into a
Shopify draft order.

**States required by the checklist:**

| Feature  | State                                                | Capture                    |
| -------- | ---------------------------------------------------- | -------------------------- |
| Briefing | ideal — max 3 items, one action each                 | `01-briefing-ready`        |
| Briefing | empty (day 1) — introduces itself + 2 things watched | `02-briefing-day-one`      |
| Briefing | "All quiet — nothing needs you today"                | `03-briefing-quiet`        |
| Briefing | AI down → yesterday's is here                        | `04-briefing-unavailable`  |
| Briefing | stale (>24h) timestamp badge                         | `05-briefing-stale`        |
| Briefing | loading — three shimmering lines                     | `06-briefing-loading`      |
| Briefing | off (no key / no plan)                               | `07-agent-off`             |
| Briefing | Arabic                                               | `08-briefing-arabic`       |
| Briefing | "Don't show this type again?" — the confirm          | `13-briefing-confirm-mute` |
| Briefing | the mute list, each with a way back                  | `14-briefing-muted`        |
| Ask bar  | idle with 3 localized examples                       | in `01`                    |
| Ask bar  | inline result panel under the bar                    | `09-ask-answer`            |
| Ask bar  | destructive intent → confirm draft, never executes   | `10-ask-destructive`       |
| Ask bar  | unparseable → "I didn't catch that" + 3 rewordings   | `11-ask-unparseable`       |
| Ask bar  | rate-limited → cooldown                              | `12-ask-rate-limited`      |
| PO       | dropzone + paste                                     | `20-po-composer`           |
| PO       | plan-gated                                           | `21-po-plan-locked`        |
| PO       | unreadable file → paste-as-text fallback             | `22-po-unreadable-file`    |
| PO       | file over the limit, with the limit stated           | `29-po-file-too-large`     |
| PO       | the picker is not every buyer, and says so           | `30-po-buyers-truncated`   |
| PO       | line-by-line: SKU + contract price + confidence      | `23-po-review`             |
| PO       | PO price differs from contract price                 | `24-po-price-delta`        |
| PO       | ambiguous line, amber, with a picker                 | `25-po-ambiguous`          |
| PO       | unmatched line listed, never dropped                 | `26-po-unmatched`          |
| PO       | draft order created                                  | `27-po-created`            |
| PO       | Arabic                                               | `28-po-arabic`             |

**Three abuse cases I invented:**

1. **A model answering outside its vocabulary.** A briefing reason containing a
   figure (in Arabic-Indic digits as well as ASCII); a briefing item about a
   fact that is not true of this shop; an invented fact kind; an Ask intent of
   `delete_rules` and of `run_sql`; an `open_builder` with no target and with a
   target outside our own pages; a PO line with a quantity of `"many"`, of `2.5`
   and of `0`; a PO price of `"$4.00"`; a PO line with neither code nor
   description.
2. **A routed parameter, and a hidden field, used as a payload.** 500 characters
   of `search`, 99,999 `days`, a negative `quantity` — and the same negative
   quantity hand-edited into the PO review screen's own hidden field, which is
   the version that would have reached `draftOrderCreate`.
3. **Wrong-tenant access.** Briefing facts, Ask answers, mutes and PO pricing
   run in shop α against rows created in shop β.

## 2. Automated

New this task:

- `tests/unit/agent-prompts.test.ts` — 25
- `tests/unit/home-page-states.test.tsx` — 16 (+14 captures)
- `tests/unit/po-page-states.test.tsx` — 14 (+11 captures)
- `tests/unit/po-envelope.test.ts` — 11 _(added in the fix round)_
- `tests/unit/briefing-status.test.ts` — 6 _(added in the fix round)_
- `tests/integration/agent.test.ts` — 20
- `tests/integration/home-view.test.ts` — 13 _(added in the fix round)_
- `tests/integration/purchase-order.test.ts` — 9 _(added in the fix round)_
- `tests/unit/orders-pages-states.test.tsx` — 1 added
- `tests/integration/customers.test.ts` — fixture typed, email/phone asserted

**Whole suite: 1,587 unit + integration across 86 files, green.**
`npx playwright test`: 287 e2e, green. `npm run lint`, `npm run typecheck`,
`npm run build`, `npm run format:check` clean. No key and no prompt in the
client bundle — grepped after a real build.

Properties worth naming:

- **A briefing reason with a digit in it is refused** — in any script. The
  single rule the feature rests on, asserted directly.
- **A stored briefing holds no figure.** Asserted by serialising it and looking
  for the number.
- **An item the merchant dealt with overnight disappears.** The order is paid
  between two `linesFor` calls and the line is gone.
- **The Ask bar changes nothing.** After routing "delete all my pricing rules",
  the rule count is unchanged — and there is no intent that could have.
- **A purchase order is priced by the engine, never by the document.** A line
  claiming $4.00 against a $6.50 contract price is charged $6.50, and the
  difference is shown rather than applied.
- **A hand-edited quantity of −5, of 2.5 or of 0 is refused** before anything
  reaches Shopify.

## 3. States, walked

`npm run qa:capture` renders each state and screenshots it into this directory.
Twenty-five captures, including Arabic for both surfaces.

**What this proves:** which content and which states render, and that no raw
catalog key reached the page. **What it does not prove:** what a merchant sees.
Polaris `s-*` elements do not upgrade here, so every capture's styling is a
stand-in. No visual pass has happened, here or anywhere.

## 4. Boundary

- **Briefing facts are per shop.** Shop β's overdue order does not appear in
  shop α's facts, and β's briefing is invisible to α, which still reads "day
  one".
- **Ask answers are per shop.** The same probe through `answerAsk` returns zero.
- **A mute does not cross shops.** β muting a kind leaves α's briefing intact.
- **Muting is validated.** `muteKind("everything")` and `unmuteKind("everything")`
  both throw a `Response`, so the mute list cannot be filled from a form post,
  and `?confirm=<script>` produces no confirm at all.
- **PO pricing is per shop.** A 90%-off rule created in β does not touch α's
  purchase order: the line prices at α's list price.
- **PO-to-order is gated server-side.** A shop without the plan or the key gets
  402 from the action, so posting to the route directly cannot reach the model.

## 5. Invariants

1. **Every price comes from the engine.** PO lines are priced by `priceLine` —
   the same function the quote path uses — and the line total is
   `multiplyMoney(unitPrice, quantity)`, which refuses a fractional or unsafe
   quantity. The document's own price is never charged and is only formatted for
   display. The briefing and the Ask bar state no price at all; `explain_price`
   deliberately hands the merchant to the price explainer rather than guessing
   which buyer they meant.
2. **Every query is shop-scoped.** Every new Prisma call is inside the scoped
   client; §4 probes five different ways in.
3. **AI drafts; a person approves.** The briefing writes a recommendation and
   decides nothing. The Ask bar has no write path at all. The one write —
   creating a draft order — is the merchant's click, and its audit entry is
   `aiAssisted` with the approving user, which `recordAudit` requires.
4. **Nothing claims to have happened that did not.** Four distinct states for
   "the agent has nothing to say", each with its own sentence and each asserted
   in `briefing-status.test.ts`. A saved briefing never carries a figure. A
   search that never ran reads "unchecked", not "nothing matched". "That file is
   too big" now says how big. The buyer picker says when it is not everybody.
   `wholesale_week` reports a count against last week's count rather than a
   percentage, because one order last week makes "▲ 400%". Two currencies are
   never summed — the count is honest and the amount absent.
5. **Deciding shows its working.** Every briefing item carries our figure and a
   link to the page that proves it. Every PO line shows what it matched, how
   sure that is, and which rule set its price. Muting and unmuting are both in
   the audit log with the staff member who did it.

## 6. The cold read, and what it found

The `qa-engineer` subagent returned **FAIL** on seventeen findings. All are
fixed; the gate was re-run from step 2. The ones that would have hurt a
merchant:

1. **A purchase order priced as though nobody was buying it.** `buyers()` listed
   the hundred largest, and the chosen buyer was resolved out of that same list
   with `find` — so on a shop with more than a hundred approved buyers, buyer
   101's contract prices silently became list prices. Now fetched by id when the
   list does not hold them, with `?buyerId=` as a way in from the customers
   list, and the page says the list is capped.
2. **The merchant's answer to an ambiguous line reached the screen but not the
   price.** `chosen` was applied when rendering, not when matching. It is now a
   `MatchOptions` field, so the pick reaches the price and the order.
3. **The line total was the unit price.** Invisible on a one-unit line, wrong by
   two hundred times on a real one. Now `multiplyMoney`, asserted.
4. **A throttled catalogue search read as "nothing in your catalogue matched".**
   A new `unchecked` confidence, from `searchVariantsResult`, says the search
   never ran.
5. **A reason with an Arabic-Indic digit passed the no-figures rule.** `/\d/` is
   ASCII-only. The check now covers both Arabic digit ranges.
6. **"All quiet" over six waiting applications.** `items.length === 0` was
   reading as "nothing to say" whether or not the agent had run. Six statuses
   now, with a recorded failure distinguishing "could not be reached" from
   "looked and found nothing".
7. **Muting was a one-way door.** One click, no confirm, no list, and
   `unmuteKind` was called from nothing. Now a confirm (a link, so the question
   writes nothing), a mute list under the briefing with an unmute each, and both
   directions audited.
8. **"in the next 1 days".** The day window was interpolated as a bare number
   into a sentence pluralised on something else. It is its own pluralised phrase
   now — two categories in English, six in Arabic.
9. **The stale badge printed an ISO date.** Now formatted in the merchant's
   language by the loader.
10. **"That file is too big" never said how big.** It does now, formatted.

Smaller ones, also fixed: the daily briefing job could stop rescheduling itself;
Home never scheduled one for a shop that installed before the job existed; the
overdue-invoice scan and the Ask bar's reads were unbounded; a `credit_exceeded`
fact existed with no way to reach it; `mutedKinds` could return duplicates.

**The finding that explains the rest** was that `matchPurchaseOrder` — the
module that decides what goes on a merchant's order and at what price — had no
test of its own, and neither did the home view. Both do now
(`tests/integration/purchase-order.test.ts`, `tests/integration/home-view.test.ts`),
which is why this round could be re-run rather than re-argued. The hidden-field
codec and the file sniffing moved out of the route into
`app/lib/orders/po-envelope.server.ts` so they could be tested at all, and the
home view moved to `app/lib/agent/home-view.server.ts` for the same reason.

## 7. Bugs found in the first run, and fixed

1. **`/app/orders/quotes` has been unreachable since 3.3**, and `/app/orders/po`
   would have shipped the same way. The orders tab bar on the list, limits and
   terms pages named only three of the five pages in the section. All five tab
   bars now reach all five pages, asserted in two tests.
2. **`Customer.email` and `Customer.phone` are deprecated** in the Admin API —
   found by validating all 29 of the app's GraphQL operations against Shopify's
   real schema, which is the first check on them that was not a guess. Moved to
   `defaultEmailAddress.emailAddress` and `defaultPhoneNumber.phoneNumber`.
3. **A test fixture typed `as never` hid the consequences of that fix.** The
   customer node fixture was untyped, so the migration nulled every synced
   buyer's email address and no test failed. Now typed `CustomerNode`, with the
   email and phone it produces asserted.

## 8. Open, not passed

- **No briefing has ever been written by Claude and no purchase order read.**
  There is no `ANTHROPIC_API_KEY` here. Every path is driven through an injected
  `MessagesApi`.
- **No draft order has ever been created.** `draftOrderCreate` is now
  schema-validated but has never run against a store. The `create` action's own
  glue — decode, re-match, create, audit — is covered a piece at a time
  (`po-envelope`, `purchase-order`, `quotes`, `audit`) but not end to end, because
  driving the route needs a Shopify session this environment cannot mint.
- **No visual pass**, as since 0.1.
- **⌘J does not focus the Ask bar**, **the Ask bar does not stream and its
  examples do not rotate**, and **PDF/xlsx parsing is not implemented** — stated
  differences from the checklist, with reasons, in `DECISIONS.md` (2026-09-10)
  and `docs/adr/0021`.

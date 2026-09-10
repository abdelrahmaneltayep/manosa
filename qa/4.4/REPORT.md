# QA — 4.4 Merchant Agent briefing, Ask Mannon bar, PO-to-order

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

> **Status: gate run, independent cold read still outstanding.** The seven steps
> below were run in full and are clean. A second, adversarial pass by the
> Autopilot `qa-engineer` subagent — which sees the diff and not the
> conversation — was still running when this was committed. Its verdict and any
> fixes land in a follow-up commit; this report is not the final word on the
> task.

## 1. Test plan

Spec re-read: `feature-checklist.md` §1 (Merchant Agent briefing, Ask Mannon
bar) and §5 (✦ PO-to-order); `pages-features.md` §1, §5 and §12; `brand.md` §5.

**Happy paths.** A briefing written overnight, shown with today's figures, each
item one click from its source. A question answered from the merchant's own
rows. A pasted purchase order matched, priced from the engine, and turned into a
Shopify draft order.

**States required by the checklist:**

| Feature | State | Capture |
|---|---|---|
| Briefing | ideal — max 3 items, one action each | `01-briefing-ready` |
| Briefing | empty (day 1) — introduces itself + 2 things it will watch | `02-briefing-day-one` |
| Briefing | "All quiet — nothing needs you today" | `03-briefing-quiet` |
| Briefing | AI down → yesterday's is here | `04-briefing-unavailable` |
| Briefing | stale (>24h) timestamp badge | `05-briefing-stale` |
| Briefing | loading — three shimmering lines | `06-briefing-loading` |
| Briefing | off (no key / no plan) | `07-agent-off` |
| Briefing | Arabic | `08-briefing-arabic` |
| Ask bar | idle with 3 localized examples | in `01` |
| Ask bar | inline result panel under the bar | `09-ask-answer` |
| Ask bar | destructive intent → confirm draft, never executes | `10-ask-destructive` |
| Ask bar | unparseable → "I didn't catch that" + 3 reformulations | `11-ask-unparseable` |
| Ask bar | rate-limited → cooldown with seconds | `12-ask-rate-limited` |
| PO | dropzone + paste | `20-po-composer` |
| PO | plan-gated | `21-po-plan-locked` |
| PO | unreadable file → paste-as-text fallback | `22-po-unreadable-file` |
| PO | line-by-line: SKU + contract price + confidence | `23-po-review` |
| PO | PO price differs from contract price | `24-po-price-delta` |
| PO | ambiguous line, amber, with a picker | `25-po-ambiguous` |
| PO | unmatched line listed, never dropped | `26-po-unmatched` |
| PO | draft order created | `27-po-created` |
| PO | Arabic | `28-po-arabic` |

**Three abuse cases I invented:**

1. **A model answering outside its vocabulary.** A briefing reason containing a
   figure; a briefing item about a fact that is not true of this shop; an
   invented fact kind; an Ask intent of `delete_rules` and of `run_sql`; an
   `open_builder` with no target and with a target outside our own pages; a PO
   line with a quantity of `"many"`, of `2.5` and of `0`; a PO price of
   `"$4.00"`; a PO line with neither a code nor a description.
2. **A routed parameter used as a payload.** 500 characters of `search`, 99,999
   `days`, a negative `quantity`.
3. **Wrong-tenant access.** Briefing facts, Ask answers and segment-style
   lookups run in shop α against rows created in shop β.

## 2. Automated

New:

- `tests/unit/agent-prompts.test.ts` — 25
- `tests/unit/home-page-states.test.tsx` — 14 (+12 captures)
- `tests/unit/po-page-states.test.tsx` — 12 (+9 captures)
- `tests/integration/agent.test.ts` — 20
- `tests/unit/orders-pages-states.test.tsx` — 1 added
- `tests/integration/customers.test.ts` — fixture typed, email/phone asserted

**Whole suite: 1,544 unit + integration across 82 files, green.**
`npx playwright test`: 285 e2e, green. `npm run lint`, `npm run typecheck`,
`npm run build`, `npm run format:check` clean. No key and no prompt in the
client bundle — grepped after a real build.

Properties worth naming:

- **A briefing reason with a digit in it is refused.** The single rule the
  feature rests on, asserted directly.
- **A stored briefing holds no figure.** Asserted by serialising it and looking
  for the number.
- **An item the merchant dealt with overnight disappears.** The order is paid
  between two `linesFor` calls and the line is gone.
- **The Ask bar changes nothing.** After routing "delete all my pricing rules",
  the rule count is unchanged — and there is no intent that could have.

## 3. States, walked

`npm run qa:capture` renders each state and screenshots it into this directory.
Twenty-one captures, including Arabic for both surfaces.

**What this proves:** which content and which states render, and that no raw
catalog key reached the page. **What it does not prove:** what a merchant sees.
Polaris `s-*` elements do not upgrade here, so every capture's styling is a
stand-in. No visual pass has happened, here or anywhere.

## 4. Boundary

- **Briefing facts are per shop.** Shop β's overdue order does not appear in
  shop α's facts.
- **Ask answers are per shop.** The same probe through `answerAsk` returns zero.
- **Muting is validated.** `muteKind("everything")` throws a `Response`, so the
  mute list cannot be filled with arbitrary strings from a form post.
- **PO-to-order is gated server-side.** A shop without the plan or the key gets
  402 from the action, so posting to the route directly cannot reach the model.

## 5. Invariants

1. **Every price comes from the engine.** PO lines are priced by `priceLine` —
   the same function the quote path uses. The document's own price is never
   charged and is only ever formatted for display. The briefing and the Ask bar
   state no price at all; `explain_price` deliberately hands the merchant to the
   price explainer rather than guessing which buyer they meant.
2. **Every query is shop-scoped.** Every new Prisma call is inside the scoped
   client; §4 probes it.
3. **AI drafts; a person approves.** The briefing writes a recommendation and
   decides nothing. The Ask bar has no write path at all. The one write —
   creating a draft order — is the merchant's click, and its audit entry is
   `aiAssisted` with the approving user, which `recordAudit` requires.
4. **Nothing claims to have happened that did not.** Four distinct states for
   "the agent has nothing to say", each with its own sentence. A saved briefing
   never carries a figure. `wholesale_week` reports a count against last week's
   count rather than a percentage, because one order last week makes "▲ 400%".
   Two currencies are never summed — the count is honest and the amount absent.
5. **Deciding shows its working.** Every briefing item carries our figure and a
   link to the page that proves it. Every PO line shows what it matched, how
   sure that is, and which rule set its price.

## 6. Bugs found, and fixed

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

## 7. Open, not passed

- **The independent cold read is outstanding** — see the note at the top.
- **No briefing has ever been written by Claude and no purchase order read.**
  There is no `ANTHROPIC_API_KEY` here. Every path is driven through an injected
  `MessagesApi`.
- **No draft order has ever been created.** `draftOrderCreate` is now
  schema-validated but has never run against a store.
- **No visual pass**, as since 0.1.
- **⌘J does not focus the Ask bar**, and **PDF/xlsx parsing is not
  implemented** — both stated differences from the checklist, with reasons, in
  `DECISIONS.md` (2026-09-10) and `docs/adr/0021`.

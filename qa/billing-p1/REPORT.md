# QA — the billing P1s from `qa/0.3/COLD-READ.md`

**Date:** 2026-09-18
**Scope:** P1-1 through P1-9. P1-1 was fixed in the P0 round; eight remain.
**Verdict:** eight fixed, one part of one deferred with the reason stated. The
reviewer's suite now runs **15 passed / 0 failed**, from 9 failed / 2 passed.

## What was wrong, and what now happens

### P1-2 · The quota was racy at every call site

`count()` → `assertWithinLimit()` → `create()` with the count **outside** the
transaction, in four places. `gate.server.ts` documented the race in its own
docstring and could not close it. Measured: two concurrent `createForm` calls on
a one-form plan, ten attempts, **two forms created on nine of them**.

**Fixed** with `createWithinLimit`, which takes the count and the insert in one
transaction. A transaction alone is not enough — Postgres' READ COMMITTED lets
both transactions count the same rows, because neither has written anything the
other conflicts on — so it first takes a per-shop **advisory lock**, held to the
end of the transaction and released however it ends. Keyed on shop *and* limit,
so a merchant creating a form does not wait behind one creating a pricing rule,
and skipped entirely on unlimited plans, where there is no count to protect.

All four call sites moved onto it: `createForm`, `duplicateForm`, `createRule`
and the CSV batch import.

### P1-3 · Nothing reconciled the cached plan

ADR 0005 lists three freshness mechanisms. There were two:
`syncSubscriptionIfStale` had **no caller outside its own tests**.

It matters where it is least visible. If the `app_subscriptions/update` delivery
is lost, nothing corrects the cache — and the storefront surfaces that gate
correctly (the Buyer Agent, quick order, the variants block) all read it. A shop
that cancelled kept them until somebody happened to open the Plans page.

**Fixed:** called from the `/app` layout loader, which every admin page already
goes through. One Admin call an hour, and it swallows its own failures, so a
billing blip cannot take the admin down.

### P1-4 · Four capabilities were sold and do not exist

`shipping_rules`, `quote_assistant`, `api_sync` and `priority_support` appear
nowhere in `app/`, `extensions/` or `packages/` outside `plans.ts`, and the
comparison table rendered each of them **Included**. So Growth was sold on
wholesale shipping rules and Agentic on an API and priority support. `pos` and
`markets` are the same: one occurs as an order-source label, the other as a rule
targeting dimension, and neither is a thing a merchant gets by paying more.

**Fixed by marking, not deleting.** Deleting would hide a roadmap a merchant may
reasonably want to see; leaving them indistinguishable from what ships today is
selling them. They are `PLANNED_FEATURES` now: the table has a third answer,
**Planned**, with a note saying what it means — *"we have not built it yet… you
are not paying for it today"* — and the plan cards leave them out of what a tier
adds, because a card is a promise about now.

Two tests hold both directions: nothing without code behind it is presented as
included, and nothing that has shipped stays marked planned.

### P1-5 · Four checklist §9 items deferred at 0.3

Three built, one not:

- **One-click resume after cancellation.** `plans.cancelled.resume` was written
  and never rendered, so a merchant whose subscription had ended read "pick a
  plan and everything comes back" beside no way to do it. The banner carries the
  button now — their **own previous plan**, not an upsell, because this is a
  resume and offering something dearer at the moment they lapsed is the dark
  pattern.
- **Export offered before a downgrade.** `plans.change.exportFirst`, likewise
  orphaned. Now rendered in the overage warning, and only while the merchant's
  current plan still includes the export — a link that redirects them back here
  is worse than no link.
- **Trial-ending email at three days.** Did not exist; the only warning was an
  in-app banner, on the one page a merchant whose trial is ending has no reason
  to open. There is a `billing.trial_reminder` job now: daily, re-queued before
  anything can fail, sent once per trial, and quoting the price for their
  **actual interval**.
- **Plan advisor — not built.** It needs a month of usage and an AI surface with
  its own gate, timeout, retry and manual fallback. The placeholder copy is
  honest about being a placeholder, and this is the one §9 item still open.
  Named here rather than quietly left.

### P1-6 · The trial banner quoted the wrong price

`plan.monthlyPrice` regardless of `view.interval`, so an annual trialist read
"Agentic is $99 a month" and was then charged **$990, once**.

**Fixed:** two strings, chosen by interval, with the price read from the same
interval. The one-size string is deleted rather than corrected, so the next
person cannot reach for it.

### P1-7 · The 14-day trial could be taken repeatedly

The billing config asks for fourteen days on all four paid plans and Shopify
issues whatever it is asked for. Nothing recorded that a shop had already had
one — so cancel-and-resubscribe, or merely flipping the monthly/annual toggle
this page invites, bought another free fortnight. For ever.

**Fixed:** `Shop.trialUsedAt`, stamped the first time a trial is seen by either
writer and never cleared, and `billing.request` passes `trialDays: 0` once it is
set. A trial is a thing a shop has *had*.

### P1-8 · ✦ surfaces called the model with no plan gate

Two, said the cold read. It was **twenty**: `feature` was optional on `aiGate`
and `requireAi`, and most call sites left it out — so a Free shop reached Claude
through the segment builder, the rule-describer, the CSV column mapper and more,
on the app owner's key.

**Fixed by making it required.** A default would have made the same mistake
reachable again; an optional field on a gate is a hand-kept list of who
remembered. Every site now names the capability that pays for it, and `"none"`
is a deliberate, commented escape with exactly two uses — the daily briefing,
which checks its entitlement three lines above, and the permission tests, which
are about the other half of the gate.

### P1-9 · The webhook could not express a trial, and left dates stale

It mapped `ACTIVE → ACTIVE` and wrote neither `trialEndsAt` nor
`currentPeriodEnd`, so **any delivery during a trial told the cache the trial
was over** — no days-left pill, no three-day banner — until a Plans page sync
happened to restore it. On a cancellation it left the old `currentPeriodEnd`,
which is what `plans.change.takesEffectAtPeriodEnd` prints as the date the
merchant "keeps" their plan until.

**Fixed:** the payload's `trial_days` and `current_period_end` are read, `ACTIVE`
with a trial still running becomes `TRIAL`, a payload missing the fields does not
erase what a sync already knew, and a cancellation clears both rather than
leaving a promise about a subscription that has ended.

## Tests

| Fix   | Committed test                                                  | Probe |
| ----- | --------------------------------------------------------------- | ----- |
| P1-2  | the probe itself (F6 drives ten concurrent pairs)                | F6 ✓  |
| P1-3  | grep-based probe                                                 | F11 ✓ |
| P1-4  | `tests/unit/plans.test.ts` (3 new)                               | F9 ✓  |
| P1-5  | `tests/integration/trial-reminder.test.ts` (9 new)               | —     |
| P1-6  | probe + `plans-page-states` fixtures                             | F8 ✓  |
| P1-7  | `tests/integration/billing.test.ts` (2 new)                      | —     |
| P1-8  | the type system: `feature` is required, 20 sites had to name one | —     |
| P1-9  | `tests/integration/billing.test.ts` (3 new)                      | —     |

F8 and F9 asserted the old shape and were rewritten with the reasoning in
place: F8 now checks the two interval-specific strings exist and the one-size
string does not; F9 checks the property that matters — nothing without code
behind it is rendered "Included" — plus the reverse, that a shipped capability
does not stay marked planned.

## What this does not prove

Unchanged: no egress to Shopify from this environment, so a real
`billing.request` round trip is still unverified — including whether
`trialDays: 0` is honoured on the request as the SDK's types say it is
(`RequestConfigLineItemOverrides` carries it). That is the dev-store check for
P1-7 and it is listed rather than asserted.

The trial-ending email is exercised against a stub transport. Whether Resend
delivers it is the same dev-store question every other email in this app has.

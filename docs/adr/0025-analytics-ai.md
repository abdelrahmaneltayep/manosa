# 25. Two features that read charts, and never compute one

Status: accepted (phase 6.3)

## Context

Checklist §7 asks for two ✦ features on the analytics page:

> **Ask-your-data:** answers cite the chart they derive from ("from: Revenue by
> group"); no-data answer offers what _can_ be answered; every claim
> reproducible via a linked filter state.
>
> **Monthly review:** generated 1st of month, kept forever, diff vs previous
> month; every recommendation has a one-click draft action + "why" expander
> showing the data behind it.

Both put a language model in front of a merchant's own numbers. The failure
mode is the same one the Buyer Agent was built around: a confident figure that
nothing computed. It is worse here, because an analytics page is _where a
merchant goes to check_ — a wrong number on it is a wrong number they will
believe over their own recollection.

## Decision

### The model routes; it never answers

Asking a question runs: route → read the chart → write a sentence → check it →
substitute. The model's first job is to name **one of the seven charts** and a
window, both from closed lists. This app then computes the answer from the same
module that draws that chart, and hands the model a set of **slots** — `{{f1}}`,
`{{q1}}`, `{{n1}}` — to write prose around. `checkReply` refuses any digit
outside a slot, in any script; `fillSlots` substitutes afterwards.

All three of §7's requirements fall out of that one decision:

- **The citation is not a claim.** "From: Revenue by group" names the chart the
  number was actually read from, not the chart the model says it thought about.
- **The link reproduces it.** `/app/analytics?range=30#groups` re-runs the same
  query against the same window, so a merchant can check the figure rather than
  trust it.
- **A no-data answer offers what can be answered**, because this app knows which
  charts have rows in them without asking anybody.

A `focus` that matches nothing is _said_. "Your top buyer is Café Aroma" in
answer to "how did Nobody Ltd do?" is a wrong answer that reads like a right
one, and is the single most likely way this feature would mislead.

The guard is the Buyer Agent's, imported rather than re-implemented. It is the
check that must not be weakened by accident, and two copies is two chances.

### A review is written once, and kept

The monthly review is a job on the first of the month — in the **shop's own
timezone**, because a Sydney merchant's March begins while it is still February
in UTC, and a review headed "March" written from a February boundary is a
review of something else. `MonthlyReview` is keyed `[shop, month]` and a re-run
returns the existing row: a merchant reading August in September and again in
March must read the same words, or comparing months is comparing noise.

The figures the sections were written from are stored **beside** them, and the
"why" expander shows those rather than asking the model to remember its own
reasoning. A recommendation a merchant cannot audit is one they cannot act on —
and one they cannot argue with, which is worse.

### A recommendation is a link, never a change

`REVIEW_ACTIONS` is eight entries long and every one is a page in this admin.
There is no action that creates, edits or archives anything. The most a wrong
recommendation can do is open the wrong page, with that page's own
confirmations intact. This is invariant 3 at its cheapest: there is no AI write
path here to need an approval, because there is no AI write path.

### A quiet month says so

`quiet` is a field on the row, distinct from "no review exists". Three states,
three different screens: never written, written and quiet, written with
findings. A month in which nothing happened is a real answer, and five
paragraphs about nothing is how a merchant learns to stop reading these.

Likewise, a first review carries no diff. "No change" would be a claim about a
month that does not exist.

## Consequences

- One new model, `MonthlyReview`, shop-scoped like everything else.
- One new job kind, `analytics.monthly_review`, which queues the next month
  **first and unconditionally** — the daily briefing once stopped for good on a
  shop that happened to be on the wrong plan the day it ran, and the same
  mistake here costs a year rather than a day.
- Two new AI features in the registry, both gated on `merchant_agent`, both
  with the timeout, the one retry and the manual fallback every AI path in this
  app has. With no key, the ask bar says Claude is not connected and the review
  page says where the figures still are — the charts, which need neither.
- The analytics page itself stays ungated (see `DECISIONS.md`, 2026-09-11): a
  merchant cannot decide whether to pay for the Merchant Agent without first
  seeing what their wholesale is doing.

# 21. An agent that reads, routes and never acts

Status: accepted (phase 4.4)

## Context

Phase 4.4 puts Claude on the home page. The briefing tells a merchant what
needs them; the Ask bar answers questions about their own business; PO-to-order
turns somebody's emailed purchase order into a draft order at contract prices.

These are the first surfaces where Claude is not asked for a draft of one
object. It is asked what matters, what the merchant means, and what a document
says — and the merchant will believe the answers, quickly, at nine in the
morning, without checking.

## Decision

### The agent never supplies a number

`briefingFacts` computes every figure from the database. Each fact carries the
page that proves it. The model is given those facts and answers with **kinds and
one line of reasoning each** — there is nowhere in a `BriefingItem` to put a
figure, and `readBriefing` refuses a reason containing a digit outright.

That last rule looks blunt and is the point. Checklist §1 says "briefing never
invents a metric — every number linked to its Analytics source". A model that
writes "you have 6 applications waiting" has written a number that can be wrong;
a model that writes "someone is waiting on you to decide" beside our own "6
applications" cannot.

It also solves staleness. Because nothing stored has a number in it, a briefing
written yesterday renders today's figures under yesterday's timestamp — which is
the only honest combination. An item whose fact is no longer true is dropped
rather than shown: the merchant dealt with it overnight.

### Three kinds of silence, and none of them is quiet

`WAITING`, `quiet`, `unavailable` and `off` are four different cards. "All quiet"
means the agent looked and found nothing, and it carries a timestamp so it is
believable. "Unavailable" means today's could not be written, and shows the last
one with a banner. "Off" means no key or no plan. A merchant acts differently on
each, and a single empty card would collapse all four into "the feature is
broken".

### The Ask bar has no code path to a write

The model's whole job is to **route**: it maps a question to one of nine intents
and pulls out its parameters. Eight are reads. The ninth, `open_builder`,
produces a link.

There is no intent that writes, so there is nothing for a jailbreak to reach.
"Delete all my pricing rules" routes to `open_builder`, and the worst a bad
routing can do is answer a question the merchant did not ask. That is a stronger
guarantee than any amount of prompt hardening, and it is why the checklist's
"destructive intents always route to a confirm draft, never execute" is
satisfied structurally rather than by instruction.

Every parameter is bounded on the way in — days, quantities and free text are
clamped by `readAsk`, because a model is not a validator.

### PO-to-order prices from the engine, and prints the disagreement

Checklist §5: "Totals always recomputed from Mannon rules — never trust the PO's
own prices". Claude reads _lines_ out of the document — a code, a description, a
quantity. Every price comes from `priceLine`, which is the engine the checkout
Function runs. The document's own figure is carried through only so the screen
can print "the document says $4.00; your contract price is $4.10".

Matching is the catalogue's job, not the model's. An exact SKU is an exact
match; one result is likely; several is a question with a picker; none is a row
that says so. Nothing is dropped, which is the other half of the checklist's
rule.

## Consequences

- `MerchantBriefing` is a new table and `Shop.briefingMuted` a new column. A
  briefing is written by a daily job and shown until the next one, rather than
  regenerated on view: one that changed on every refresh is not something a
  merchant can act on, and it would cost a model call per page load.
- **⌘J does not focus the bar.** The shortcut needs a client-side key listener,
  and every admin screen here is a props-only component with no client
  JavaScript — the reason any of their states can be exercised at all in an
  environment with no Polaris. Shipping an untestable listener into an embedded
  iframe is worse than not shipping it. Recorded in `DECISIONS.md`.
- **PDF and spreadsheet parsing is not implemented.** Neither is in the fixed
  stack, and adding a parser is a stack change. A file we cannot read as text
  produces the checklist's own error state — "Couldn't read this — paste the
  lines as text?" — reached honestly rather than by omission.
- The Ask bar's `explain_price` hands the merchant to the price explainer rather
  than guessing which of their buyers they meant. A price without a buyer is not
  a price this app is willing to state.

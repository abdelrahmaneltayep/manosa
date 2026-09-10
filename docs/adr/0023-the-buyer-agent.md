# 23. A concierge that cannot invent a price

Status: accepted (phase 5.1)

## Context

Phase 5 puts Claude on the merchant's storefront, talking to their buyers.
`pages-features.md` §6 calls it "the page no competitor has": a trade buyer types
"reorder my usual, but double the espresso beans" and gets a cart at their own
contract prices; asks "what's my price for SKU-450 at 100 units?" and gets an
answer without a support ticket.

The checklist's §6 states the hard rule twice, which is unusual for that
document:

> a hard rule: the agent can never invent a price — it only reads your published
> rules
>
> Hard behaviors: prices only from published rules (**test asserts this**);
> checkout always handed to Shopify

That is the whole problem. Everything else here — the tools, the guardrails, the
conversation log — is ordinary. What is not ordinary is that a language model is
about to quote prices to somebody else's customers, in writing, on the
merchant's domain, and a merchant who has to honour a wrong one will not care
that the model was confident.

## Decision

### The model does not write numbers

A turn runs in this order: route the question to one tool → **run the tool** →
write the reply → check the reply → substitute → store both halves.

Every tool returns a **slot table**: `{{f1}}` a unit price, `{{t1}}` a line
total, `{{q1}}` a quantity, `{{s1}}` a code, `{{total}}` a subtotal — each
already formatted in the buyer's own locale. The model writes prose around those
names and never a figure. `checkReply` then refuses a reply containing any
Unicode digit outside a slot, any currency or percent word, or a slot that was
not supplied; `fillSlots` puts the values in afterwards.

**The first version of this was a scanner, and it did not work.** It looked for
things that resembled money in the model's reply and compared them with a list
of formatted figures. An independent review got five different invented prices
past it: `\d` is ASCII-only in JavaScript even under `/u`, so an Arabic reply
reading "٩٫٠٠" was invisible; a currency symbol could be swapped and the number
left alone; "1 200,50" and "120 050" collapse to the same digits; "900 dollars"
carries no symbol at all; and a percentage collided with a yen amount. It also
**refused the two flows the spec leads with**, because `\b[A-Z]{3}\s*\d` reads
"NET 30" and "SKU 450" as money.

Every one of those is closed by construction now rather than by a better
pattern, which is the point: the check is "is there a digit outside a slot",
and that is a question with a right answer in every script.

This is the same shape as the Merchant Agent's rule that a briefing reason may
not contain a digit (`docs/adr/0021`), and for the same reason: a prompt is a
request, a check is a rule.

Rejected: asking the model nicely (the failure is silent and the merchant is
liable); templating whole sentences (a concierge that cannot form one is not a
concierge, and this ships in Arabic too); and re-pricing what the model said
afterwards (it says things that are not prices, and re-pricing a hallucinated
SKU proves nothing).

### The model chooses a tool; it never runs one

`tools.server.ts` is the whole list of what this agent can do, and it is eight
entries long. Six are reads. One files a quote _request_ for the merchant to
price. One declines. **There is no tool that checks out**, so a conversation
cannot end in a charge; and **there is no tool that sets a price**, so the agent
can report one and has nowhere to write one.

The security model of the feature is therefore the length of that list, which is
a thing a person can read in a minute and a test can assert exhaustively.

### Guardrails are checked in our code, not in the prompt

A merchant switching off "may file a quote request" does not add a sentence to
the prompt. It removes the tool from the list the model is offered _and_ is
re-checked inside `runTool` immediately before the work — so an agent whose
`canRequestQuote` is off has no code path to a quote at all.

The merchant's own instructions are a bounded, advisory string. They cannot
switch an ability back on, and `lintInstructions` warns when they read as though
they could — the checklist's own example, "you wrote 'offer discounts freely'
but discount authority is off", plus the ones no setting grants: negotiating,
matching a price, placing an order. It warns rather than blocks, because the
instructions cannot do the thing anyway and refusing to save them would be
theatre.

### Only approved buyers, and only when the merchant has published

Four gates, in this order: the app's plan includes `buyer_agent`; the merchant
has published the agent; the visitor is an **approved** wholesale customer
(unless guest mode is explicitly on); and no merchant has taken the conversation
over. The first three are checked before any model call, so a shop that has not
published pays nothing to find out.

The customer id comes from the App Proxy's signature and from nowhere else. It
is the only thing standing between a stranger and another buyer's order history,
which is why the agent has no parameter for "who am I".

### A conversation is kept for ninety days, and then it is not

`AgentConversation` and `AgentMessage` hold what was said, because a merchant
who cannot read what their agent told their buyers should not publish one. The
checklist says "Retention 90d"; a recurring job enforces it, scheduled from the
first conversation rather than from whenever somebody opens the admin.

## Consequences

- Three new models, all shop-scoped by the tenant extension like everything
  else: `AgentGuardrails` (one row per shop), `AgentConversation`,
  `AgentMessage`.
- Two model calls per turn — route, then write. Cheaper than one call with tool
  definitions, and it puts the figure check between the tool and the buyer,
  which is the only place it can go.
- A buyer may take twenty turns in ten minutes. Per buyer, not per shop: one
  buyer cannot spend the merchant's whole budget, and cannot mute the agent for
  everyone else either.
- The widget, the guardrails panel and the conversation log are 5.2 and 5.3.
  Until then the agent is unpublished by default and reachable only by a signed
  proxy request, which is the correct state for something with no UI.

---

## Addendum (phase 5.3): the three screens

### The pre-publish checklist is a gate, not a nudge

Four items, and `publishAgent` re-checks all four before it flips the switch —
the disabled button is a courtesy, and the screen is one POST away from anybody
with a session. Three are answered by a query (an **active** rule, an
**approved** buyer, a rehearsal the agent actually **answered**), the way the
setup checklist answers its six: a checklist that ticks on the existence of a
row rather than on the state of it lies to the merchant about whether they are
ready.

The fourth cannot be a query. Nothing can tell whether a person read a page, so
"guardrails reviewed" is the merchant saying they did, recorded with a
timestamp, from a button deliberately separate from Save — a box that ticks
itself whenever somebody presses Save is answering a different question.

Unpublishing has no gate and no dialog. The checklist says "no confirm-shaming"
and it is right: a merchant switching this off is usually doing it because
something is wrong, and a confirmation is a sentence they read while it is
still talking to their customers.

### Test mode is a real conversation with the writes removed

`answerBuyerTurn` takes `testMode`, and it changes exactly two things: an
unpublished agent answers (rehearsing before publishing is the whole point of
the fourth checklist item), and the two tools that write — `request_quote` and
`escalate` — file nothing. Both **say so** in the reply rather than silently
no-oping, because `refusal` is a fact the writer prompt is given: the merchant
reads "I'd normally pass that on", not a quote number that does not exist.

Everything else is identical, against a **real** buyer's context — their tags,
their group, their rules, their terms. A rehearsal against an invented buyer
proves nothing about the prices this agent will quote, which is the only
question a rehearsal is for.

A rehearsal is stored in the log like any other conversation, flagged
`testMode`, and labelled on every surface it appears on: the row, the
transcript, and a column in the CSV. A merchant reading their own test as a
buyer's conversation is exactly what invariant 4 is about.

### Closed, not deleted, not back-dated

"Start a fresh test" needed a way to stop `openConversation` continuing the
existing thread. `AgentConversation.closedAt` does it. The two alternatives were
both worse: deleting the rehearsal loses evidence the merchant may want after
changing a guardrail (and unticks the publish checklist), and moving
`lastMessageAt` out of the idle window puts a lie in a column that the log then
reports as fact.

### Taking over is one-way, and replying is taking over

The agent announces the human in the buyer's own thread, so "actually, never
mind" would mean a buyer who was told a person had joined going back to talking
to a model. Pressing it twice announces once. Sending a reply takes the
conversation over whether or not the button was used first — the alternative is
the agent answering over a person mid-thread.

Neither is offered on a rehearsal: there is nobody on the other end to hand to,
and `takeOver` and `replyAsMerchant` both refuse one rather than relying on the
screen to hide the buttons.

---

## Addendum (5.3 fix round): what the cold read found

An independent review returned **FAIL** on 5.3 with seventeen findings. Four
changed the design rather than the code, and they are recorded here because the
first version of each looked reasonable.

### Take over had no delivery path, and both sides were told otherwise

`replyAsMerchant` wrote an `AgentMessage` and stopped. There was no route from
that row to the buyer: the proxy had no GET, the widget never polled, no mail
was sent — while the widget told the buyer _"someone from the team has joined —
they'll reply here"_ and the admin showed a green **Sent**. A spec failure
("'Take over' hands live chat to merchant") and an invariant-4 failure at once,
and the one on this page that reaches a real customer.

The fix is the honest one rather than the cheap one: a signed App Proxy **GET**
(`messagesForBuyer`) that the widget polls **only after a person has joined**.
A conversation nobody took over still costs the storefront exactly one request
per turn, which is the rule the whole widget is built on. The thread is matched
on the signed customer id as well as its own, so another buyer's conversation
reads as empty rather than refused; a rehearsal is never handed back to the
buyer it imitates; and the "a person joined" marker is filtered out, because the
buyer is told that by the widget in the buyer's own language.

### An empty agent turn already meant something else

The announcement was stored as `{ role: AGENT, text: "", refusal: "taken_over" }`
— and an empty agent turn is exactly how this app records _a turn nobody could
answer_. So the one row that exists to say "a person joined here" rendered as
"the agent couldn't answer this one. Nothing was sent to the buyer."

Two changes: the row carries real text, and the transcript checks for the
marker **before** the empty-text branch. The state capture is now built from the
rows `takeOver` and `replyAsMerchant` actually write — the old one flipped a flag
on the happy-path fixture, so neither the announcement nor a `MERCHANT` turn had
ever been rendered at all.

### "Published" is our switch; the app embed is the merchant's

`publishAgent` flipped a database flag and the panel said _"The agent is live"_.
The block is an app embed (`target: body`), off until the merchant turns it on
in the theme editor, and this app has no scope to read a theme. So for a
merchant who had not enabled it, that sentence was a claim about somebody else's
theme.

The panel now reads the two columns Home's setup checklist already uses —
`storefrontSeenAt` (proof: a proxy request can only come from a live embed) and
`embedConfirmedAt` (the merchant's own word) — and when neither is set it says
so instead.

### The fourth checklist item could be satisfied without the model

"A test conversation completed" ticked on any rehearsal that did not fail — and
an off-limits subject is declined **from a script, before either model call**.
So a shop with no API key at all could satisfy the gate with one message the
model never saw, publish, and fail every real buyer turn with `no_key`. It now
ticks on evidence that is already stored: an agent turn in a rehearsal with
`aiModel` set.

### The rest

A rehearsal spent the real buyer's rate-limit budget (`overTurnLimit` now
filters `testMode` and rehearsals have their own smaller ceiling); the publish,
save and take-over actions had no server-side plan gate; take-over was not
idempotent under concurrency and overwrote a `CART` outcome with `ESCALATED`;
`saveGuardrails` still accepted `published`, a second publish path around the
checklist; the CSV export was unbounded and ignored the filters the merchant
could see; the rehearsal picker silently answered as a _different_ buyer when
the id was outside its first fifty; refusal codes were shown to merchants raw;
and the capture guard's catalogue-root list was hand-maintained, so it had been
silently switched off for this whole page family — it is now derived from the
catalogue, which is the second time that list has been the bug.

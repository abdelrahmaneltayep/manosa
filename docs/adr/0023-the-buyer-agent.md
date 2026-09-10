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

### The reply may only repeat figures the tools computed

A turn runs in this order: route the question to one tool → **run the tool** →
write the reply → check the reply → store both halves.

Every tool returns a `figures` list: exactly the amounts it computed, already
formatted. Those are handed to the model _and kept_. The reply is then scanned
for money, and any money in it that is not in that list makes the turn a
refusal. The buyer is told something went wrong; they are never told a price.

The scanner recognises money and percentages — a symbol or an ISO code on either
side of a number, a bare decimal, `15%` — and deliberately does **not** treat a
bare integer as money, because a wholesale agent says "100 units" and "boxes of
24" all day and a check that flagged those would be switched off within a week.
Comparison is on the number rather than the formatting, so a model that writes
`90.00` where the engine said `90.00 USD` has not invented anything, while every
other number still fails.

This is the same shape as the Merchant Agent's rule that a briefing reason may
not contain a digit (`docs/adr/0021`), and for the same reason: a prompt is a
request, a check is a rule.

Rejected: asking the model nicely (the failure is silent and the merchant is
liable); templating the reply from fixed sentences (a concierge that cannot form
a sentence is not a concierge, and the checklist asks for Arabic and English
both); and verifying afterwards by re-pricing what the model said (it says
things that are not prices, and re-pricing a hallucinated SKU proves nothing).

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

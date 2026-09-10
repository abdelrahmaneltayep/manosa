# 16. Quotes: price once, and let the number survive

Status: accepted (phase 3.3)

## Context

A quote is a promise. A buyer asks "what would 500 of these cost?", the merchant
answers, and that answer has to still be true when the buyer comes back a week
later with a purchase order. Everything else about quotes — the states, the
email, the expiry — exists to serve that one property.

Shopify has draft orders, which are the right destination: a merchant can
invoice, edit and complete one, and their accounting apps already watch them.
What Shopify has no concept of is the negotiation before it: a priced offer with
a date on it, that a buyer can accept from a link.

## Decision

### The engine is asked once, at draft time

`draftQuote` calls `resolvePrice` per line and writes what it said onto
`QuoteLine` — the unit price, the list price, and which rules produced it. Then
nothing re-prices. Not the accept path, not the buyer's page, not the draft
order.

This is why quotes are their own table rather than a draft order with a note on
it. A draft order re-reads its variants; a quote must not.

`acceptQuote` therefore does no pricing at all, and there is a test that proves
it: after the merchant halves the wholesale discount, the accepted quote still
charges the quoted price, and the price that reaches Shopify's
`originalUnitPriceWithCurrency` is still the quoted one. Without that field
Shopify would re-read each variant and the promise would evaporate at the last
step.

### Drift is shown, never applied

Once a quote is locked, the detail page re-runs the engine **for display only**
and marks any line the store would now price differently. A merchant about to
honour a fortnight-old quote wants to know that; they do not want the app to
quietly change it. Re-pricing is a button they press.

### The state machine is shared, not repeated

Three callers need to agree about what a quote allows: the merchant's page, the
buyer's accept page, and the expiry job. `app/lib/quotes/state.ts` is a pure
module with no clock in it, so all three ask the same question and the expiry
arithmetic can be tested without waiting a fortnight.

A **sent** quote cannot be re-priced. A merchant who wants to change one
withdraws it and starts again, so a buyer can never accept one price and be
charged another.

### The buyer's link is a real credential

192 bits of randomness, not a cuid. A registration form's public id only reveals
a form; a quote's reveals one buyer's negotiated prices and lets somebody act on
them. A missing quote and a bad token are told apart by nobody: both 404.

Expiry is checked on every request to the public page as well as by the job, so
a buyer arriving a minute after the deadline is refused whatever the job has got
round to — and the page marks it expired, so what the buyer reads and what the
merchant sees agree.

### The expiry job keeps itself alive

There is no recurring scheduler in this app. `quotes.expire` re-queues itself
for just after midnight while any quote is still out with a buyer, and stops
when none is. Sending a quote queues one too. A store with nothing outstanding
runs nothing, which is the difference between a quiet queue and a daily no-op
per shop forever.

## Consequences

- **`originalUnitPriceWithCurrency` is unverified.** It is Shopify's documented
  way to override a draft order line's price, and the test asserts the exact
  field and value we send, but no draft order has been created against a real
  store. If Shopify rejects it the whole feature's promise fails at the last
  step, which is why it is called out here and in `qa/3.3/REPORT.md`.
- **A quote is priced as one order.** Cart-value rules see the line's own
  extended total, because a quote has no cart. A merchant whose rules key off a
  whole-basket subtotal will find a quote priced per line.
- **✦ The suggested response and the margin-floor check are not built** (4.x).
  The section is on the page, disabled, saying so.
- **Quotes carry no shipping, tax or discount codes.** They are a priced list of
  goods; everything else is settled on the draft order in Shopify, which is
  where a merchant expects to settle it.
- **A merchant's own price beats the engine's**, and the line then claims no
  rule — "priced by hand" rather than a rule that did not produce it.

# 17. Storefront blocks: the price comes from the app, the page works without it

Status: accepted (phase 3.4)

## Context

Two blocks a wholesale buyer needs on the storefront: a paste-a-list quick-order
form, and a variants table with a quantity box per row. Both have to show _that
buyer's_ wholesale price, and both land on a merchant's storefront, where the
checklist gives them a ≤10-point Lighthouse budget and requires them to be
graceful without JavaScript.

Those three pull against each other. The price is the hard one: Liquid cannot
compute it, because the price comes from `packages/pricing-engine` and a Liquid
copy of the cascade would be a second implementation that drifts.

## Decision

### Prices come through a signed App Proxy

The blocks call the app at `/apps/mannon/…` on the merchant's own domain.
Shopify forwards the request with the shop and `logged_in_customer_id`, signed.

**That signature is the whole security model.** Without it, anyone could ask for
any buyer's contract prices by putting a customer id in a query string. So:

- the signature is checked before anything else, in `withProxy`, which is the
  only door into the proxy routes;
- the tenant scope is opened from the _signed_ shop before any query runs;
- a missing `SHOPIFY_API_SECRET` refuses every request rather than defaulting to
  something.

It is not the webhook HMAC scheme — webhooks sign the raw body in base64, proxy
requests sign the sorted query string in hex — and the two are kept in separate
modules so neither can be used for the other.

### The two blocks degrade differently, because they are different

**Quick order cannot work without JavaScript**, and says so. There is no SKU
lookup to be had without a request, so the block shows a `<noscript>` note and a
link to the catalogue — the checklist's stated fallback — and the form is
`hidden` until the script un-hides it. A form that cannot submit is worse than
no form.

**The variants table works completely without JavaScript.** The theme already
rendered the variants and their prices, so the table is real HTML and each row
posts to Shopify's own `/cart/add`. A buyer without a script still adds a mixed
case to their cart, and still pays the wholesale price — because the checkout
Function applies it whatever the page said. What the script adds is the price
_shown in advance_, which is an enhancement to a page that already works.

**One form per row, not one form for the table.** A single form would post every
variant including the ones left at zero, and `/cart/add` refuses a line of zero.
"Add all" is the script's contribution, and it is not on the page until the
script is there to make it work.

### The budget is met by not spending it

No external script, no stylesheet, no library, no build step. Both blocks are
inline and under 16KB, which a test enforces. The variants table fetches nothing
until an `IntersectionObserver` says it is near the viewport; a browser without
one fetches immediately rather than showing nothing.

### List prices travel as minor units

Liquid's `variant.price` is already an integer in the currency's subunit, so the
variants block sends it as-is. A decimal round-trip would be wrong in every
three-decimal currency, which is half this app's market — and is exactly the bug
3.2 shipped and 3.3 had to check for.

## Consequences

- **No Lighthouse run has happened.** It needs a real storefront this
  environment cannot reach. What is enforced instead is the set of things that
  would spend the budget: an external script, a library, a render-blocking
  fetch, a block that does nothing without JavaScript. `qa/3.4/REPORT.md` says
  the real run is still owed.
- **The blocks are rendered by a stand-in for testing.** `tests/support/
liquid-stand-in.ts` is enough Liquid to get a block into Chromium, so the
  **JavaScript that ships** can be driven against a stubbed proxy. It does not
  prove Shopify renders the markup identically.
- **Quick order is on the Pro plan**, alongside CSV import and auto-tagging. The
  spec does not place it; see `DECISIONS.md`.
- **The SKU lookup is one query for the whole paste**, capped at 100 SKUs. A
  longer paste is truncated and the buyer is told, rather than the app making
  forty round trips against a rate limit shared with pricing.
- **A guest sees list prices**, not a refusal. They are not signed in, so there
  is no tier to apply — and refusing to price a public catalogue would be odd.
- **Both blocks stamp `_mannon_source: quick_order`** on the cart, which is what
  the orders list (3.1) reads to show the "Quick order" chip. Shopify reports
  every app extension's cart as the storefront, so nothing else could tell them
  apart. In the variants table it is in the markup, so it survives without JS.

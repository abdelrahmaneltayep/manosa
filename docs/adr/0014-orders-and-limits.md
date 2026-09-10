# 14. Mirror orders; enforce limits in a validation Function

Status: accepted (phase 3.1)

## Context

Phase 3.1 is two features that look unrelated and are not: the wholesale orders
list, and order limits. Both come down to the same question — where does a
number live, and who is allowed to say it.

The orders list has to sort by "overdue first", filter by how an order was
placed, total a period, and paginate. Order limits have to hold a cart at
checkout, and to show the merchant, in the admin, exactly the sentence their
buyer will get.

## Decision

### Orders are mirrored, for the reasons in ADR 0010

An `Order` row per Shopify order, per shop, kept current by
`orders/create`, `orders/updated`, `orders/cancelled` and `orders/edited`, and
seeded by a backfill job that pages with a cursor. The Admin API cannot answer
"wholesale orders on terms, overdue, oldest debt first, page 3" — it has no such
sort and no page 3 — and asking it per keystroke would spend a rate limit shared
with pricing.

Three things follow from mirroring that are worth stating.

**`orders/edited` flags, it does not write.** That payload is a diff of line
items with no totals in it. Rewriting an order's total from a partial picture
would be worse than showing a stale one, so the row is flagged and the list
shows a resync badge. The `orders/updated` that follows the edit carries the
whole order and clears it.

**Wholesale is decided once, on the way in.** Whether an order counts as
wholesale is read from the buyer as they were at the time. Re-deciding it on
every update would mean approving a buyer today silently rewrote last month's
revenue figure.

**The list reaches 60 days back, and says so.** `read_orders` is capped there
unless Shopify grants `read_all_orders`, which is a review-time request. A page
that quietly showed two months and looked like it showed everything would be a
merchant drawing conclusions from a partial history.

### Limits are a pure module, published as a metafield

`packages/order-limits` decides everything — which limit applies to a buyer,
whether a cart violates it, how big the gap is, and whether a limit a merchant
typed is coherent at all. It imports nothing but `@mannon/pricing-engine`.

The same module runs in three places: the admin's validation, the admin's
preview, and `extensions/mannon-limits` at checkout. That is the point. A second
copy of the rules living in a form is how an admin ends up telling a merchant
one thing while the cart tells their buyer another.

A Function cannot call our API, so limits travel as a shop metafield, written on
every change and skipped when the hash is unchanged — the same shape as the
pricing ruleset in ADR 0007.

**The Function never throws.** A validation Function that fails blocks every
checkout in the store, retail included. Every branch either produces an error
message or returns none; a limit we cannot read is dropped, which can only ever
let an order through.

### Limits are scoped by country, not by market

Shopify's validation input hands the Function `localization.country.isoCode`
directly. Mapping that to a market would need a `markets` query, a stored
mapping, and a way to keep it current — for a distinction most merchants express
as "in Saudi Arabia" anyway. Countries are what the Function is given, so
countries are what a limit is written in. If a merchant asks for markets, the
mapping is additive.

## Consequences

- A wholesale order that predates the install by more than 60 days is not in the
  list, and the page says so rather than implying otherwise.
- The buyer's limit message is English until Settings § 6.2 makes the templates
  editable. The Function has no ICU, so money there is formatted as
  "USD 38.00"; the admin uses `Intl` and shows "$38.00".
- `write_orders` is requested for exactly one thing: tagging a wholesale order so
  the merchant can find it in Shopify's own admin. It is written once, on the
  order's first arrival — a merchant who removes the tag meant to.
- POS carts never reach the validation target, so the "POS bypasses limits"
  setting is honoured by the app when it publishes rather than by the Function.

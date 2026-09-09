# 10. Mirror Shopify's customers rather than querying them per request

Status: accepted (phase 2.1)

## Context

The Customers page has to search, filter, sort and paginate wholesale buyers,
show what each has spent, and flag the ones who have gone quiet. Every one of
those is a query.

The Admin API cannot serve that page. `customers(query:)` supports a narrow
search grammar, not "in this group, on terms, tax-exempt, no order in 60 days";
it paginates by cursor, so there is no page 7; and every keystroke would be a
round trip against a rate limit shared with pricing, publishing and the
Function. A merchant with four thousand buyers would get a page that is slow
when it works and empty when Shopify is busy.

## Decision

Keep a `Customer` row per Shopify customer, per shop.

- **Webhooks keep it current.** `customers/create` and `customers/update`
  upsert; `customers/delete` flags the row rather than removing it.
- **A backfill job seeds it**, one page of 250 at a time, re-queueing itself
  with the cursor. It is scheduled on install, and again on reinstall — the app
  may have been gone for months and webhooks do not backfill.
- **The upsert is atomic.** Prisma emits `INSERT … ON CONFLICT DO UPDATE` for
  this shape (verified against the emitted SQL), so the backfill and a webhook
  writing the same buyer at the same instant cannot produce two rows or a
  crash.
- **Shopify stays the source of truth.** Every write this app makes — tags, the
  tax-exempt flag — goes to Shopify first and to the mirror second. Tags are
  written with `tagsAdd` and `tagsRemove`, never by setting the whole list: other
  apps tag the same customers, and silently dropping a loyalty app's tags is a
  support ticket nobody can diagnose.

## What a deleted customer costs

The row survives the `customers/delete` webhook, marked `deletedInShopifyAt`.
Removing it immediately would drop a row out of an open list mid-scroll, change
a group's member count under the merchant, and lose the history behind a tier.
The list shows the row greyed with a "deleted in Shopify" chip and no controls;
the retention job in 7.2 removes it for good.

## What this is not

The mirror is not a second source of truth and holds no price. The lifetime
spend on a row is Shopify's own total for that customer, formatted with the
pricing engine's money formatter — it is a historical fact, not a price this
app computed. Every price on every surface still comes from the engine.

## Consequences

- The Customers page is one indexed query, so filters and pagination are real
  rather than best-effort.
- The mirror can be stale for as long as a webhook is late. The list says so
  when it knows, and every value it shows is a fact from Shopify rather than a
  decision we made from one.
- Two extra scopes were already in the manifest (`read_customers`,
  `write_customers`); nothing new was added for this.

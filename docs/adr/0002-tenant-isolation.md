# ADR 0002 — Fail-closed tenant isolation

**Status:** accepted (phase 0.1)

## Context

Mannon is multi-tenant by `shop`. One missing `where: { shop }` leaks one
merchant's wholesale prices, customer list, or net-terms ledger into another
merchant's admin. Review cannot be the only control: the app will end up with
hundreds of queries across seven phases.

Prisma's `$use` middleware is deprecated, so the mechanism is a client
extension (`$extends`).

## Decision

`app/lib/tenant/shop-scope.server.ts` wraps the Prisma client and, for every
model carrying a scalar `shop` field:

- merges `shop = <active tenant>` into `where` for reads, updates and deletes;
- stamps `shop` onto `data` for creates;
- **throws** if there is no active tenant, rather than running unfiltered;
- **throws** `CrossTenantError` if the caller supplies a `shop` naming a
  different tenant, or a filter object (`{ in: [...] }`) that could match
  several — refusing is safer than trying to intersect it;
- **throws** on any Prisma operation it does not recognise, so a future Prisma
  release cannot introduce a read path that slips past the filter.

The scoped-model set is derived from the runtime DMMF, not a hand-maintained
list, so a new table is protected the moment it has a `shop` column.
`UNSCOPED_MODELS` is the only exit, and each entry carries its reason.

The active tenant lives in an `AsyncLocalStorage` store entered by
`shopScope.run()`. `run()` is used rather than `enterWith()` because, under HTTP
keep-alive, `enterWith()` can bleed a store into later requests on the same
socket.

## Why creates still name the tenant

Prisma keeps `shop` required in its generated create inputs, and rewriting those
types would mean re-deriving Prisma's whole input surface through mapped types —
fragile, and it costs autocomplete. So creates spell the tenant out via
`tenant()`. The result is enforcement at both ends: the compiler makes you say
which shop you are writing for, and the extension rejects the write if it is not
the active one.

## Consequences

- Reading another shop's row by id returns `null`; updating or deleting one
  raises Prisma `P2025`, which the route layer turns into a 404. This is what
  the QA cross-tenant check exercises.
- `db.*` cannot be called from a script or job that has not opened a scope. That
  is the point; jobs use `withoutShopScope("reason", …)` or open a scope per shop.
- One trap this design created and closed: a `PrismaPromise` does no work until
  it is awaited, so returning one out of `shopScope.run()` used to execute it
  after the scope had closed. `run()` now settles thenables inside the scope, and
  `tests/unit/shop-context.test.ts` has the regression case.

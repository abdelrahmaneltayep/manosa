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
- **throws** on any _model_ operation it does not recognise, so a future Prisma
  release cannot introduce a read path on a scoped model that slips past the
  filter. Client-level operations are a separate question and are handled
  separately: `$queryRaw`, `$queryRawUnsafe`, `$executeRaw` and
  `$executeRawUnsafe` carry no model, cannot have a filter injected into an
  opaque SQL string, and are refused outside a tenant scope — each of the five
  raw call sites puts `shop` in its own `WHERE`, and a test checks every one.

The scoped-model set is derived from the runtime DMMF, not a hand-maintained
list, so a new table is protected the moment it has a `shop` column.
`UNSCOPED_MODELS` is the only exit, and each entry carries its reason.

The active tenant lives in an `AsyncLocalStorage` store entered by
`shopScope.run()`. `run()` is used rather than `enterWith()` because, under HTTP
keep-alive, `enterWith()` can bleed a store into later requests on the same
socket.

## What the extension does not reach, and what holds it instead

Two paths are closed by the schema rather than by this layer, and saying so
here is the point of the section: a reader who believes the extension covers
them will not think to check the schema when they add a table.

- **A to-one relation takes no `where` in Prisma**, so an `include` of a
  parent cannot be filtered on the way out. What makes a cross-tenant parent
  impossible is the composite `(shop, parentId)` foreign key on every owned
  relation — the database will not store one.
- **A nested `create` inside an `update` is not stamped.** The extension checks
  `shop` at the top level of an update's `data` (`assertNoRetenant`) and stamps
  nested rows on a `create`, but it does not walk an update's nested writes.
  Prisma's generated types require `shop` on those rows, and the same composite
  foreign key refuses one that names another tenant.

`tests/integration/tenant-relations.test.ts` asserts both, per relation, for
every scoped model that owns one — and fails when a new one is added without a
probe. The guard is a column on a table, and the next table has not been
written yet.

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

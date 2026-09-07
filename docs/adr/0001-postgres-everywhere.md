# ADR 0001 — PostgreSQL in every environment

**Status:** accepted (phase 0.1)

## Context

The build plan calls for "Prisma + PostgreSQL (SQLite in dev)".

Prisma's `datasource.provider` cannot be read from an environment variable, so
supporting both means either two schema files or a build step that rewrites one.
Either way the schemas drift, and they drift in exactly the places that matter
to this product:

- SQLite has no native `DECIMAL`. Prisma maps `Decimal` to a float there, so
  money arithmetic behaves differently in dev than in production. For a pricing
  engine whose whole job is to be deterministic about money, that is not a
  tolerable difference.
- SQLite has no enums, no `citext`, weaker constraint and index support, and
  different `NULL` ordering — all of which the rule cascade and the ledger will
  lean on.

## Decision

PostgreSQL everywhere: development, test, CI, production.

## Consequences

- Contributors need a local Postgres. `createdb mannon_dev mannon_test` and the
  default `DATABASE_URL` in `.env.example` cover it; CI uses the `postgres:16`
  service container.
- Integration tests run against a real database rather than a mock, which is why
  the tenant-isolation suite can assert on actual P2025 behaviour instead of on
  the arguments we hoped Prisma received.
- Deviation from the build plan's "SQLite in dev" is deliberate and is recorded
  here so it does not read as an oversight.

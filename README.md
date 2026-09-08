# Mannon — B2B Wholesale Pricing

An AI-first B2B wholesale app for Shopify: wholesale prices, registration forms,
order limits, net terms — plus a Merchant Agent in the admin and a Buyer Agent on
the storefront.

**Claude drafts, you send. It never acts on its own.**

## Stack

| Concern  | Choice                                                          |
| -------- | --------------------------------------------------------------- |
| App      | Remix + TypeScript, embedded, App Bridge (CDN)                  |
| Admin UI | Polaris **web components** (`s-*`), App Bridge `s-app-nav`      |
| Data     | Prisma + PostgreSQL, tenant-scoped (see below)                  |
| Shopify  | GraphQL Admin API only, Shopify Functions, theme app extensions |
| AI       | Anthropic API, server-side only                                 |
| Tests    | Vitest (unit + integration), Playwright (e2e)                   |

## Getting started

```bash
npm install
cp .env.example .env          # fill in the Partners app credentials
createdb mannon_dev && createdb mannon_test
npx prisma migrate deploy
npm run dev                   # shopify app dev --store=mannon-9iu9ewku.myshopify.com
```

`shopify app config link` once to populate `client_id` in `shopify.app.toml`.

## Commands

| Command                              | What it does                                      |
| ------------------------------------ | ------------------------------------------------- |
| `npm run dev`                        | Shopify CLI dev (tunnel + Remix)                  |
| `npm run build` / `npm start`        | Production build and server                       |
| `npm run lint` / `npm run typecheck` | ESLint (0 warnings) / `tsc --noEmit`              |
| `npm test`                           | Vitest — unit + integration (needs `mannon_test`) |
| `npm run test:e2e`                   | Playwright smoke tests against the built server   |

## The pricing engine — read this before showing a price

`packages/pricing-engine` answers `{ customer, product, quantity, market } →
price`. **Every price Mannon shows or charges comes from it** — the Shopify
Function, the storefront blocks, the Buyer Agent's tools, the PO parser and the
admin previews all call the same module, so the agent's answer and the checkout
total can never disagree.

```ts
const result = resolvePrice({ rules, context });
result.unitPrice; // Money — integer minor units, never a float
result.trace; // why each rule applied or did not: "Why this price?"
result.nextTier; // "add 8 more units to unlock the 12% tier"
```

Rules for working on it:

- It is **pure**: no dependencies, no I/O, no Node built-ins. It has to run in a
  Shopify Function and in a browser bundle. A test and an ESLint rule enforce it.
- It **never converts currency**. An absolute-money rule in a currency the
  merchant has not priced is skipped with `no_price_in_currency`, not converted
  at a rate we invented.
- It is **deterministic**, including the order rules arrive in.
- Golden vectors in `packages/pricing-engine/test/golden/vectors.json` were
  written from the spec before the code. Changing an expectation changes what a
  merchant is charged — argue for it in the pull request, do not re-record.

See `docs/adr/0006-pricing-engine.md`.

## Multi-tenancy — read this before writing a query

Every table holding merchant data carries a `shop` column, and **every query is
filtered by the active tenant automatically**. The rules:

- Admin routes reach the database through `withAdmin(request, handler)`
  (`app/shopify.server.ts`). It authenticates the embedded request and opens the
  tenant scope; the handler's Prisma queries are filtered from there.
- Never pair a bare `authenticate.admin()` with a `db` call. That pair is the
  mistake the scope exists to prevent.
- Creates spell the tenant out: `db.thing.create({ data: { ...tenant(), … } })`.
  The compiler requires it and the guard rejects it if it names another shop.
- A query outside any scope **throws** rather than running unfiltered.
- Genuinely cross-tenant work uses `withoutShopScope("why", …)` — greppable, and
  it needs a reason.

A new model is protected the moment it has a `shop` field; a model without one
fails `tests/unit/scoped-models.test.ts` until it is either scoped or added to
`UNSCOPED_MODELS` with a comment saying why.

See `docs/adr/0002-tenant-isolation.md`.

## Plans and gating

Free · **Pro $29** · **Growth $59** · Agentic $99 — two months free annually,
14-day trial on paid plans. Pro is the entry tier and Growth the mid tier;
`app/lib/billing/plans.ts` is the source of truth and `rank` is the ordering.

Gate on the **server**, by capability, never by plan name:

```ts
await assertFeature("net_terms"); // throws FeatureLockedError
await assertWithinLimit("pricingRules", count); // throws LimitReachedError
```

Teasers and disabled buttons are courtesy; these are the enforcement. Pass the
count to `assertWithinLimit` from inside the same transaction as the insert —
counting separately races.

A lapsed subscription **pauses** paid capability and never deletes anything:
`entitlements.plan` remembers what was bought, `entitlements.effectivePlan` is
what applies now. A failed charge keeps the plan working for a 7-day grace
period.

Set `SHOPIFY_BILLING_TEST_MODE=true` on development stores so no money moves.

See `docs/adr/0005-billing-and-gating.md`.

## Background jobs — required in every deployed environment

`JOBS_RUNNER_TOKEN` must be set and `POST /internal/jobs/run` scheduled once a
minute. Without it the runner refuses to run and the post-uninstall PII purge
never happens — a GDPR obligation, not a nice-to-have.

```
* * * * * curl -fsS -XPOST -H "Authorization: Bearer $JOBS_RUNNER_TOKEN" \
            https://<app-url>/internal/jobs/run
```

See `docs/adr/0004-webhooks-and-jobs.md`.

## Adding a webhook

1. Add the topic, URI and handler to `app/lib/webhooks/registry.ts`.
2. Declare the same topic and URI in `shopify.app.toml`.

`tests/unit/webhook-registry.test.ts` fails if the two disagree — which catches
both a handler that never runs and a subscription that 404s while Shopify
retries it for 48 hours. Handlers receive a verified payload, run inside the
shop's tenant scope, and must be idempotent: deliveries are at-least-once.

## Translating

Strings live in `app/i18n/locales/{en,ar}.json`; English is the source of truth.
`tests/unit/i18n-catalogs.test.ts` fails on a missing key, a blank string, a
mismatched `{{placeholder}}`, or English left in the Arabic file.

**Translate in components, not loaders.** On a client-side navigation there is
no `?locale=` for the server to read, while the client i18next instance already
holds the right language. Server-side text a _buyer_ will read — emails, agent
replies — uses `getShopT(shop.primaryLocale)`, because the language the admin
happens to be open in is the wrong answer for them.

See `docs/adr/0003-i18n-without-a-framework-bridge.md`.

## Repository layout

```
app/
  routes/            Remix routes — /app/* is the embedded admin (9 pages)
  lib/tenant/        Shop context + the fail-closed Prisma extension
  lib/nav/           The nine sidebar pages, one source of truth
  lib/audit/         The audit writer every AI action goes through
  lib/webhooks/      Registry, dispatch, handlers
  lib/jobs/          Durable queue, runner, handlers
  lib/billing/       Plan catalog, entitlements, the gate, subscription sync
  components/        Presentational components, renderable without a router
  i18n/              Locale config and the EN/AR catalogs
  db.server.ts       The scoped Prisma client every feature uses
  shopify.server.ts  Shopify app config, withAdmin()
packages/
  pricing-engine/    The one source of every price. Pure and dependency-free.
prisma/              Schema and migrations
tests/               unit · integration · e2e
qa/                  Per-task QA state captures
```

Progress and phase gates: `PROGRESS.md`. QA verdicts: `QA-REPORT.md`.

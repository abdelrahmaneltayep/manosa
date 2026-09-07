# QA report

One entry per task. A task is complete only on a clean pass — a run that finds
bugs is fixed and re-run from the automated-tests step. Deployment waits for
every task in the phase to have a clean entry, green CI, and an approved phase
summary.

---

## 0.1 — Scaffold, auth, session storage, shop-scoped Prisma, CI

**Verdict: pass with open items.** Everything in scope is implemented and green.
Two verification steps cannot be executed in this environment and are carried
forward to the first task that runs against the dev store; they are listed under
Open items rather than counted as passed.

### 1. Test plan

Task 0.1 predates the feature checklist's per-feature states — there is no rule
list or approval queue yet to be empty or loading. What it owns is the app shell,
so the plan covers the shell states plus the isolation guarantee everything later
depends on.

_Happy paths_

- Unembedded entry (`/`) renders and asks for a store domain; the form targets
  Shopify's login flow.
- All nine sidebar pages exist, are reachable under `/app/*`, and are wired to
  `s-app-nav` with exactly one `rel="home"`.
- An authenticated request opens a tenant scope and upserts the install record.
- `/healthz` answers without touching the database.

_States_

- **Error (404):** unknown route renders the designed message, not a stack trace.
- **Error (unauthenticated):** `/app` refuses rather than rendering the admin.
- **Degraded:** the pages render meaningfully when the App Bridge CDN is
  unreachable and the custom elements never upgrade.
- **Mobile:** no horizontal scroll (Built for Shopify).
- Empty / loading / partial / AI states: not applicable at 0.1 — no feature data
  and no AI call sites exist yet. They begin at 1.3.

_Three invented abuse cases_

1. **Malformed input** — a `where` that tries to widen the tenant: a literal
   `shop` naming another store, a `{ in: [...] }` filter object, an `OR` branch
   spanning both shops, and an empty-string tenant.
2. **Concurrency** — two tenants writing on interleaved timers, the later-started
   one finishing first, asserting neither write lands under the wrong shop.
3. **Wrong shop/tenant** — read, update and delete another shop's row by primary
   key; create a row claiming another shop.

### 2. Automated tests

`npm test` — **40 passed** (4 files).

| Suite                                        | Cases | Covers                                                                                                                         |
| -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| `tests/unit/shop-context.test.ts`            | 11    | Scope entry/exit, nesting, concurrency isolation, lazy-thenable regression, `tenant()`, bypass accounting                      |
| `tests/unit/scoped-models.test.ts`           | 3     | DMMF-driven scoped-model discovery; no model both unscoped and unexempted                                                      |
| `tests/unit/nav-routes.test.ts`              | 5     | Nine pages in spec order, one home, every nav entry has a route file, unique i18n keys                                         |
| `tests/integration/tenant-isolation.test.ts` | 21    | Fail-closed behaviour, automatic scoping, cross-tenant reads/updates/deletes, scope-widening attempts, abuse cases, exemptions |

`npx playwright test` — **9 passed** (smoke 5, QA state captures 4).
`npm run lint` (0 warnings), `npm run format:check`, `npm run typecheck`,
`npm run build` — all clean.

Integration tests run against a real PostgreSQL database, not a mock, so the
cross-tenant cases assert Prisma's actual `P2025` behaviour rather than the
arguments we hoped it received. Admin-API mocks (MSW) arrive with 1.2, the first
task that calls the Admin API.

### 3. State walkthrough

Captured to `qa/0.1/`:

| File                              | State                                                     |
| --------------------------------- | --------------------------------------------------------- |
| `install-page-desktop.png`        | Unembedded entry, 1280×900                                |
| `install-page-mobile.png`         | Same at 390×844, asserted free of horizontal scroll       |
| `install-page-required-field.png` | Submit with an empty domain — native required-field error |
| `error-404.png`                   | Unknown route, root error boundary                        |

Captures are produced by `tests/e2e/qa-states.spec.ts`, so they regenerate rather
than rot.

### 4. Cross-tenant check

Required: reading another shop's record by ID must 404.

At the data layer this is proven directly — see `tests/integration/tenant-isolation.test.ts`:

- `findUnique` on another shop's row by primary key → `null`
- `update` on another shop's row → Prisma `P2025` (record not found)
- `delete` on another shop's row → Prisma `P2025`
- `create` claiming another shop → `CrossTenantError`
- `where: { shop: <other> }` and `where: { shop: { in: [...] } }` → `CrossTenantError`
- any scoped query with no tenant context at all → `MissingShopContextError`

`null` and `P2025` are exactly what a route loader turns into a 404. The HTTP-level
assertion needs a route that fetches a record by id, and no such route exists yet
— the first one (Pricing rule detail, 1.3) will add it. Carried to 1.3.

### 5. The three musts

| Rule                                                              | Status at 0.1                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price on any surface that did not come from the pricing engine | Vacuously true — no surface displays a price yet. The engine lands in 1.1, before any price is rendered anywhere.                                                                                                                               |
| No AI mutation without an approval record                         | Vacuously true — no AI call sites, and `ANTHROPIC_API_KEY` is unset. Enforced from 4.1.                                                                                                                                                         |
| No unhandled promise rejections in logs during the e2e run        | **Checked.** `tests/e2e/smoke.spec.ts` fails on any `pageerror`. Server output during the run contains one expected line — Remix's `No route matches URL "/definitely-not-a-page"`, which is the 404 case the test provokes — and nothing else. |

### 6. Bugs found and fixed

Both were found by the tests, not by reading the code, and both were re-run from
step 2 after fixing.

1. **Tenant context was lost on every scoped query.** A `PrismaPromise` does no
   work until it is awaited, so `shopScope.run(shop, () => db.x.findMany())`
   built the query inside the scope and _executed_ it after the scope had closed
   — every scoped query failed as if it had no tenant. 13 of 29 tests failed.
   Fixed by settling thenables inside the scope (`settleInScope` in
   `app/lib/tenant/shop-context.server.ts`), so the ergonomic spelling is also
   the correct one. Regression test: "keeps the tenant for a thenable that only
   runs when awaited".

2. **The error page's heading was invisible without App Bridge.** The root error
   boundary put its heading only in the `heading` attribute of `s-page` /
   `s-banner`. Those are custom elements; if App Bridge has not loaded — which is
   the norm on unembedded routes, and the case whenever the CDN is blocked — the
   attribute renders as nothing and the user gets a bare sentence with no title.
   Fixed by rendering the heading as a child `s-heading` as well.

A third issue surfaced during typechecking and was a design fix rather than a
bug: Prisma keeps `shop` required in generated create inputs, so the extension
could only ever be a net, never the source. Rather than re-derive Prisma's input
types, creates now spell the tenant out with `tenant()` — the compiler requires
it, and the guard rejects it if it names another shop. Enforcement at both ends.

### 7. Open items (carried forward, not passed)

- **Embedded-admin state walkthrough.** The nine `/app/*` pages need a real
  Shopify session to render, and this build environment has neither app
  credentials nor egress to `cdn.shopify.com` (the proxy returns 403), so App
  Bridge and Polaris web components cannot load at all. Screenshots taken here
  would show unstyled markup and would misrepresent the app. **Must be walked on
  `mannon-9iu9ewku.myshopify.com` before the Phase 0 gate.**
- **HTTP-level 404 on cross-tenant fetch by id** — no by-id route exists yet;
  add the assertion with the first one (1.3).
- **CI has not run.** The workflow is written against `postgres:16` service
  containers and mirrors the commands verified locally, but it has not executed
  on GitHub Actions yet. First push proves it.

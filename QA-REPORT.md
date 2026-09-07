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

---

## 0.2 — Webhook framework, audit log, i18n EN/AR

**Verdict: pass with one open item.** Everything in scope is implemented and
green. The embedded-admin walkthrough carried over from 0.1 is still blocked in
this environment and still blocks the Phase 0 gate.

### 1. Test plan

_Happy paths_

- A correctly signed webhook reaches its handler, exactly once, in the sending
  shop's tenant scope.
- Uninstall revokes sessions, tombstones the install, and schedules the PII
  purge inside the 48h window.
- The purge clears contact details and redacts the audit trail without deleting
  its shape.
- Reinstalling before the purge runs cancels it and keeps the setup.
- An audit entry is written for install, reinstall, uninstall and purge.
- Arabic renders mirrored, translated, and server-side.

_States_

- **Error (unsigned/forged webhook):** rejected before any handler runs.
- **Error (handler failure):** delivery keeps its reason, 500 asks Shopify to
  retry, job backs off exponentially and eventually gives up.
- **Degraded (no runner token):** the endpoint refuses and says why, loudly.
- **Degraded (no JavaScript):** the document is already in the right language.
- **Edge (unknown topic / removed handler):** acknowledged or failed, never an
  infinite retry.

_Three invented abuse cases_

1. **Malformed input** — a webhook signed over a body with an extra field
   injected, and one signed with the wrong secret entirely.
2. **Concurrency** — the same delivery replayed, two runners racing for one job,
   and a job left `RUNNING` by a killed process.
3. **Wrong shop/tenant** — an uninstall for shop A while shop B has a live
   session and install record; the same webhook id arriving for two shops.

### 2. Automated tests

`npm test` — **103 passed** (9 files), up from 40.

| Suite                                        | Cases | Covers                                                                                                                                                                 |
| -------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/i18n-catalogs.test.ts`           | 16    | Catalog parity, blanks, placeholder drift, untranslated leftovers, locale normalisation, detection order, server-side `t`                                              |
| `tests/unit/webhook-registry.test.ts`        | 7     | Topic normalisation, resolution, duplicate guard, registry ↔ `shopify.app.toml` drift in both directions                                                               |
| `tests/integration/webhooks.test.ts`         | 13    | Real HMAC accept/reject, forged body, wrong secret, delivery records, replay, failed-attempt retry, per-shop ids, unknown topic, the full uninstall path, cross-tenant |
| `tests/integration/audit.test.ts`            | 7     | Writer, tenant scoping, AI provenance, the approval invariant, transaction enlistment                                                                                  |
| `tests/integration/jobs.test.ts`             | 17    | Enqueue/replace/cancel, due selection, multi-tenant pass, backoff, exhaustion, removed handler, stuck requeue, the purge and its skip conditions, runner endpoint auth |
| `tests/integration/tenant-isolation.test.ts` | 23    | 0.1's suite plus transaction scoping                                                                                                                                   |
| (0.1 suites)                                 | 20    | Unchanged                                                                                                                                                              |

`npx playwright test` — **17 passed** (smoke 11, QA captures 6), up from 9.

HMAC is exercised for real: `tests/support/webhook-request.ts` signs requests
the way Shopify does, and the route's own `action` is called, so verification,
dispatch, idempotency and the handler all run as they do in production. No mock
sits between the test and the thing being tested.

Lint (0 warnings), format, typecheck and build all clean.

### 3. State walkthrough

Captured to `qa/0.2/` (regenerated by `tests/e2e/qa-states.spec.ts`):

| File                                                   | State                                                |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `install-page-desktop.png` / `install-page-mobile.png` | English, 1280 and 390 wide                           |
| `install-page-arabic-rtl.png`                          | Arabic, mirrored, two-tone headline intact           |
| `install-page-arabic-rtl-mobile.png`                   | Same at 390 wide, asserted free of horizontal scroll |
| `install-page-required-field.png`                      | Empty-domain submit                                  |
| `error-404.png`                                        | Root error boundary                                  |

### 4. Cross-tenant check

- An uninstall for shop A leaves shop B's session and install record untouched.
- The same `webhookId` from two shops produces two independent delivery rows.
- The purge job for shop A does not touch shop B's contact details.
- Audit entries are readable only within their own tenant.
- The job runner's cross-tenant sweep is the one deliberate exception, written
  as `withoutShopScope("job runner serves every shop", …)`, and it re-enters
  each job's own scope before touching anything.

### 5. The three musts

| Rule                                           | Status at 0.2                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | Still vacuously true — no surface shows a price. Engine lands in 1.1.                                                                                                                                                                                                |
| No AI mutation without an approval record      | **Now enforceable, and enforced.** `recordAudit` refuses any entry marked `aiAssisted` that names no approver, and refuses it _before_ writing, so a failed check leaves no row. Two tests cover it. No AI call sites exist yet; 4.1 wires the paths through this.   |
| No unhandled promise rejections in the e2e run | **Checked.** The page-error tracker still passes. Server output contains three expected lines: the provoked 404, the deliberate job failure from the backoff test, and the `JOBS_RUNNER_TOKEN is not set` warning — which is the endpoint correctly refusing to run. |

### 6. Bugs found and fixed

1. **The install page headline was never translated.** A source edit silently
   failed to apply — the pattern it looked for had already been reformatted —
   so the headline, accent and body stayed hardcoded English while the form
   around them translated. Every unit test passed: catalog parity was fine,
   because the keys existed and were simply never used. Caught by looking at
   the Arabic screenshot. Fixed, and `tests/e2e/smoke.spec.ts` now asserts that
   none of the English install copy appears anywhere on the Arabic page.

2. **Arabic was only correct after hydration.** The server-side
   `I18nextProvider` was missing for the same reason, so the document arrived in
   English and JavaScript replaced it. Every JS-enabled test passed. Fixed, and
   there is now a `javaScriptEnabled: false` suite asserting the server itself
   emits Arabic — which is also the state a slow connection sees, and an RTL
   layout flipping after paint is a CLS failure that Built for Shopify measures.

3. **A test seam that quietly disabled the code under test.** `vi.spyOn` on the
   extended Prisma client does not restore — `db.shop` is a proxy — so a stub
   from an earlier test leaked into a later one, `findUnique` returned
   `undefined`, and the purge skipped while reporting success. The fix was to
   stop faking at that level: `runDueJobs({ handlers })` now takes the handler
   table, so retry and backoff are exercised without reaching inside a handler.

All three were re-run from step 2 after fixing.

### 7. Open items

- **Embedded-admin state walkthrough** — unchanged from 0.1 and still blocking
  the Phase 0 gate: the nine `/app/*` pages need a real Shopify session, and this
  environment has no app credentials and no egress to `cdn.shopify.com`.
- **Operational, not a defect:** `JOBS_RUNNER_TOKEN` must be set and
  `/internal/jobs/run` scheduled in every deployed environment, or the GDPR PII
  purge never runs. The endpoint fails closed and logs, README and ADR 0004 say
  so, and 7.2 should verify it as part of the release checklist.
- **Deferred by design:** the three mandatory GDPR compliance webhooks
  (`customers/data_request`, `customers/redact`, `shop/redact`) belong to 7.2.
  The framework takes them as three registry entries when that task comes.
  Pruning old `WebhookDelivery` rows is likewise a retention job (7.2); the
  index is in place.

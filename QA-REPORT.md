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

---

## 0.3 — Billing: plans, gate middleware, Plans page

**Verdict: pass with open items.** Everything in scope is implemented and green.
Two parity items are deliberately deferred with reasons (§7), and the
embedded-admin walkthrough carried from 0.1 still blocks the Phase 0 gate.

### 1. Test plan

_Happy paths_

- The ladder prices and entitles as agreed: Free · Pro $29 · Growth $59 · Agentic $99.
- An active subscription grants its plan; the gate allows what it includes.
- Upgrading explains proration before any charge; downgrading names what pauses.
- The subscription webhook applies a change without waiting for a page load.

_States (checklist §9)_

- **Current plan always visible** — a badge on the usage card and on its plan card.
- **Usage meters vs limits, with an 80% warning** — and a separate at-limit state.
- **Upgrade:** proration explained, then Shopify's own confirm screen.
- **Downgrade:** impact preview listing exactly what pauses and what is over quota.
- **Trial:** days-left pill, and a banner from three days out.
- **Billing errors:** failed charge → 7-day grace banner; a rejected request →
  "nothing was charged".
- **Cancelled:** features paused, data intact, one click to resume.
- Plan Advisor: not built — see §7.

_Three invented abuse cases_

1. **Malformed input** — a subscription named `enterprise-monthly` that no plan
   claims, arriving from both the sync and the webhook.
2. **Concurrency** — repeated `FROZEN` webhooks and repeated syncs, each of
   which could restart the grace clock and hand out an unlimited free ride.
3. **Wrong shop/tenant** — one shop's subscription webhook and sync while
   another shop is installed, checking neither plan nor gate leaks.

### 2. Automated tests

`npm test` — **193 passed** (16 files), up from 103.

| Suite                                      | Cases | Covers                                                                                                                |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/plans.test.ts`                 | 14    | Ladder order and ranks, prices, annual saving, tier supersets, feature placement, billing-id round trip and stability |
| `tests/unit/entitlements.test.ts`          | 10    | Every status: none, trial, active, in-grace, grace expired, cancelled, unknown plan key                               |
| `tests/unit/plan-change.test.ts`           | 7     | Direction, gaining/losing, tightening quotas, exact overage counts                                                    |
| `tests/unit/usage.test.ts`                 | 7     | Meter arithmetic, the 80% threshold, unlimited, over-limit, divide-by-zero                                            |
| `tests/unit/subscription-snapshot.test.ts` | 13    | Shopify status mapping, trial maths, two subscriptions mid-change, unrecognised names                                 |
| `tests/unit/plans-page-states.test.tsx`    | 16    | Every §9 state rendered and asserted, plus Arabic and a no-dark-patterns check                                        |
| `tests/integration/billing.test.ts`        | 22    | Cache writes and audit entries, grace clock, staleness, API outage, the gate, the webhook, cross-tenant               |

`npx playwright test` — **32 passed** (smoke 11, QA captures 21).
Lint (0 warnings), format, typecheck and build clean.

The Plans component takes plain props and imports nothing from Remix, so every
state is rendered for real in the test rather than described. That was a
deliberate response to this environment: the embedded admin cannot be driven
outside the Shopify iframe, and without it these states would have gone
unverified until release.

### 3. State walkthrough

Fourteen states rendered and captured to `qa/0.3/` (`npm run qa:capture`):

| Capture                        | State                                 |
| ------------------------------ | ------------------------------------- |
| `01-free-empty`                | Free, nothing used                    |
| `02-free-at-limit`             | Quota reached                         |
| `03-nearing-limit`             | 80% warning                           |
| `04-pro-active`                | Paid plan, unlimited meters           |
| `05-trial` / `06-trial-ending` | Days-left pill / three-day banner     |
| `07-past-due`                  | Failed charge, inside grace           |
| `08-cancelled`                 | Features paused, data kept            |
| `09-annual`                    | Yearly pricing and the saving         |
| `10-upgrade-confirm`           | Proration explained before charge     |
| `11-downgrade-confirm`         | Impact preview with the overage count |
| `12-billing-error`             | Request rejected, nothing charged     |
| `13-test-subscription`         | Test-mode notice                      |
| `14-arabic`                    | Full RTL, Arabic plural forms         |

**What these captures do and do not prove.** They verify which content and which
states render. They are **not** a design review: Polaris web components cannot
load here, so the styling is a plain stand-in, and every capture says so in a
banner at the top of the image. Visual review still needs the dev store.

### 4. Cross-tenant check

- Syncing one shop's subscription leaves another's plan at Free.
- A subscription webhook for one shop does not change another's.
- The gate answers for the tenant making the request: the same capability is
  allowed for one shop and refused for another in the same test.
- All billing reads and writes go through the scoped client, so a missing tenant
  throws rather than reading across shops.

### 5. The three musts

| Rule                                           | Status at 0.3                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | Holds, and is now worth stating precisely: the Plans page shows **subscription** prices, which come from the plan catalog — the single source Shopify's billing config is also derived from, so the card and the charge cannot disagree. No product price is displayed anywhere yet; the pricing engine lands in 1.1 before any is. |
| No AI mutation without an approval record      | Still enforced by `recordAudit`, still no AI call sites. The Plan Advisor is the first AI surface this page will get and is deferred to Phase 4 for exactly that reason.                                                                                                                                                            |
| No unhandled promise rejections in the e2e run | **Checked.** Page-error tracking still passes across 32 tests. Server output carries only the expected lines: the provoked 404 and the `JOBS_RUNNER_TOKEN` warning.                                                                                                                                                                 |

### 6. Bugs found and fixed

1. **English plurals were spelled wrong for i18next.** The new strings used a
   bare key plus `_other`; i18next v21+ resolves English singulars as `_one`, so
   "1 pricing rule" would have rendered the plural form. Found by a new test
   asserting that every count-bearing string carries the plural categories its
   language needs — English `one`/`other`, Arabic `zero`/`one`/`two`/`few`/
   `many`/`other`. Fixed across five strings.

2. **The catalog parity test would have blocked Arabic plurals entirely.** It
   compared flat keys, so Arabic's six plural forms read as "extra keys" and
   English's missing four as gaps. Rewritten to compare base keys and check
   categories per language — otherwise the honest fix for bug 1 would have
   looked like a test failure and invited the wrong fix.

3. **An awkward interpolation.** "You have 13 more Pricing rules than Free
   allows" put a capitalised label mid-sentence. Caught by reading the capture.
   Reworded to lead with the label, in both languages.

Two capture-harness defects were also fixed so the record is not misleading:
`heading` attributes were not drawn (App Bridge draws them in production, so the
states looked headless), and the comparison table's columns did not line up.
Neither was an app bug; both would have made the QA record lie.

### 7. Open items

- **Deferred: the discount-code field** (parity list §9, not in the checklist's
  state list). Doing it properly means a code table, redemption tracking,
  expiry and per-shop limits. A field that accepts any code and quietly ignores
  it is worse than no field, so it is not shipped half-built. Recorded in
  PROGRESS.md.
- **Deferred: the Plan Advisor** (checklist §9). It needs the AI infrastructure
  from 4.1 — server-side client, timeouts, fallback, audit hooks — and a month
  of real usage to be honest about. The page carries a plain, non-AI note saying
  it is coming; the section is not faked.
- **Deferred: "export offered first" on downgrade** (checklist §9). There is
  nothing to export yet — no rules, forms or orders exist. It belongs with the
  first feature that creates exportable data (1.4, CSV export).
- **Usage meters read zero by design.** The task specifies stubbed meters. The
  arithmetic is fully tested now, and each count is a one-line change when its
  table lands (1.3 for rules, 2.2 for forms), marked with a TODO naming the task.
- **Embedded-admin walkthrough** — unchanged from 0.1, still blocking the Phase 0
  gate. Confirmed this task that it cannot be lifted here: `cdn.shopify.com` is
  denied by the egress proxy as organization policy, and no npm package ships
  the Polaris element definitions.
- **Not yet exercised against real Shopify billing.** Every billing call is
  covered against a stand-in for the billing context; `billing.request`,
  `billing.cancel` and Shopify's confirm screen have not run against
  `mannon-9iu9ewku.myshopify.com`. That needs `SHOPIFY_BILLING_TEST_MODE=true`
  and a real install — part of the same Phase 0 gate walkthrough.

---

## 1.1 — `packages/pricing-engine`

**Verdict: pass.** No open items on the engine itself. Nothing consumes it yet
by design — 1.2 wires the Shopify Function, 1.3 the Pricing page — so the "no
price from outside the engine" rule has nothing to enforce against until then.

### 1. Test plan

The task specifies golden vectors written from the spec's examples **before** the
implementation. That is what was done: 40 vectors first, then the resolver, then
one more vector added and corrected (§6).

_Happy paths, taken from the spec rather than invented_

- The three demo-store personas (§11): 35% storewide, individual variant price,
  volume tiers.
- "Buy 10 get 5%, buy 50 get 12%, only for tagged wholesale customers, exclude
  sale items" (§2 rule-from-a-sentence), at 100 units and on a sale item.
- "Give VIP customers 20% off the new collection until Friday" (§1 Ask Mannon),
  before, during and after the window.
- "What's my price for SKU-450 at 100 units?" (§6) — the Buyer Agent's most
  common question.
- "Add 1 more unit to unlock the 12% tier" (§6 tier-aware upsell).

_States and edges_

- Guest, logged-in-but-untagged, named customer, customer group, B2B company.
- Draft and archived rules; scheduled rules outside their window.
- Market include and exclude; a currency the rule has no price in; a currency it
  does.
- Cart-value tiers above, below, and with no cart at all.
- Cascade precedence; priority order; equal priority; stacking; a
  non-combinable winner; a non-combinable follower; the floor at zero.
- Rounding to the cent, and rounding once rather than per rule.

_Three invented abuse cases_

1. **Malformed input** — percentages outside 0–100, negative amounts, tiers
   whose minimum exceeds their maximum, a quantity of zero or negative, decimal
   strings with more precision than the currency allows, and `"1,000.00"`.
2. **Concurrency** — not applicable in the usual sense (the module is pure), so
   the equivalent was tested instead: the same input resolved twice must be
   identical, and rules arriving in a different order must not change the price.
   Both are property tests over 500 generated cases.
3. **Wrong customer** — a rule scoped to one named customer must never price for
   another. This is the worst bug this engine could have, so it is a vector of
   its own (`another-customer-does-not-get-that-rate`), not just a property.

### 2. Automated tests

`npm test` — **281 passed** (21 files), up from 193. The engine contributes 88:

| Suite                     | Cases | Covers                                                                                                                                                                                              |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/golden.test.ts`     | 41    | Every golden vector, each citing its spec source and what it protects                                                                                                                               |
| `test/properties.test.ts` | 10    | Never negative, always whole minor units, order-independent, deterministic, every rule traced with a reason, inactive rules inert, irrelevant rules harmless, line total consistent, quantity guard |
| `test/money.test.ts`      | 17    | Round-tripping, JPY (0dp) and KWD (3dp), padding, precision refusal, junk input, exact addition, the four rounding modes, refusal to mix currencies                                                 |
| `test/validate.test.ts`   | 15    | Every validation the checklist names, including the "10–49 overlaps 40–60" message, plus the margin guard's arithmetic                                                                              |
| `test/purity.test.ts`     | 5     | No foreign imports, no dynamic import or require, no dependencies, no clock or randomness                                                                                                           |

Lint, root typecheck, standalone package typecheck and build all clean.

The property tests run 500 generated cases each for the invariants that matter
most. The purity suite exists because portability is a promise the engine makes
to four other subsystems, and it would otherwise be discovered broken at deploy
time.

### 3. State walkthrough

Not applicable: this task ships no UI. The engine's observable states are its
resolutions, and all 41 are asserted exactly rather than screenshotted. The
Pricing page's states arrive with 1.3.

### 4. Cross-tenant check

The engine holds no data and reads no database, so there is nothing to leak
across shops — it prices only what the caller hands it. The tenant boundary
stays where it is: the caller loads rules through the shop-scoped client.

The equivalent risk at this layer is **cross-customer** leakage, which is
covered: a rule scoped to one named customer, one group, one company or one tag
must not price for anyone else. Six vectors and one property cover it.

### 5. The three musts

| Rule                                                              | Status at 1.1                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price on any surface that did not come from the pricing engine | **The engine now exists**, and nothing displays a price yet, so the rule holds trivially and starts being enforceable at 1.2. `marginFor()` lives here too, so a "sells below cost" warning and the price it warns about read from the same resolution. |
| No AI mutation without an approval record                         | Unchanged; still no AI call sites. Rule-from-a-sentence (4.2) will produce `PricingRule` objects that go through `validateRule()` before a merchant is shown them.                                                                                      |
| No unhandled promise rejections in the e2e run                    | Unchanged and still clean; the engine is synchronous and returns no promises at all.                                                                                                                                                                    |

### 6. Bugs found and fixed

Both were in the **vectors**, and both were found by checking my own arithmetic
rather than by the code disagreeing with me — which is the point of writing them
first.

1. **A clamp case that never clamped.** `stacking-clamps-at-zero-and-says-so`
   applied $2 off, then 60%, then 50% to a $10 item and expected $0.00. That
   lands at $1.60. Had it gone in as written, the resolver would have been
   changed to satisfy a wrong expectation. Replaced with a discount larger than
   the price, which reaches the floor honestly.

2. **A stacking case that tested the previous case again.** The case meant to
   cover "combinable winner, non-combinable follower" paired a combinable rule
   at priority 200 with a non-combinable one at priority 90 — so the
   non-combinable rule won and it re-tested the case above it. Caught by the
   only vector that failed on the first run; the engine was right and the vector
   was wrong. Fixed by giving the non-combinable rule a lower priority.

A third correction was to a reason code rather than a behaviour: six vectors
used `outranked`, which cannot happen under the combination model — a rule after
the winner stops because the winner forbids stacking, and saying so is more use
to the merchant reading "Why this price?". Renamed to
`not_combinable_with_winner`.

### 7. Open items

- **Nothing consumes the engine yet.** By design: 1.2 wires the Shopify discount
  Function, 1.3 the Pricing page and preview. Until then the engine is verified
  but unproven against a real checkout, which is exactly what 1.2 is for.
- **Persistence is not modelled yet.** `PricingRule` is the in-memory shape; the
  Prisma table and the mapping to it land with 1.3. The shapes are deliberately
  plain objects so that mapping is a translation, not a redesign.
- **Rule ids in vectors are synthetic.** Once rules are persisted, the golden
  vectors keep their own ids; they test the resolver, not the repository.

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

---

## 1.2 — Shopify discount Function wired to the engine

**Verdict: pass with one blocking open item.** The Function, the ruleset
publisher and the buyer-facts sync are implemented and green. The task's own
acceptance criterion — "cart/checkout applies the correct wholesale price for a
tagged customer on the dev store" — **has not been met**, because it cannot be
met from this environment. Everything up to that point is verified; §7 says
exactly what remains.

### 1. Test plan

_Happy paths_

- A tagged buyer's cart line is discounted to the engine's price.
- The discount is per unit, so quantity multiplies exactly.
- Each line prices independently; volume tiers use the line's own quantity;
  cart-value rules use the cart subtotal.
- Collection targeting and B2B company audiences resolve from the metafields
  the app publishes.
- Publishing creates the discount once, attaches the ruleset, and skips an
  unchanged ruleset.

_States_

- No ruleset published; discount class not PRODUCT; corrupt ruleset; one
  malformed rule among good ones; a line that is not a product variant; a rule
  that would raise the price; a cart-value rule priced in another currency.

_Three invented abuse cases_

1. **Malformed input** — a ruleset that is not JSON, one with a future format
   version, one whose `rules` is a string, a rule with a non-integer money
   amount, and a rule of an unknown kind. None may throw: see §5.
2. **Concurrency** — the publisher racing itself. Covered by the hash check
   (an unchanged ruleset is a no-op) and by asserting a second publish does not
   create a second discount.
3. **Wrong shop/tenant** — publishing for one shop must not set another's
   discount id or ruleset hash.

### 2. Automated tests

`npm test` — **337 passed** (24 files), up from 281. This task adds 56:

| Suite                                         | Cases | Covers                                                                                                                                            |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/mannon-discount/test/run.test.ts` | 22    | Checkout behaviour end to end, agreement with the engine, and every failure mode                                                                  |
| `packages/pricing-engine/test/codec.test.ts`  | 16    | Wire-format round trip, identical pricing before and after, and eight ways of being handed a damaged ruleset                                      |
| `tests/integration/ruleset-publish.test.ts`   | 18    | The exact mutations and variables sent, discount reuse, hash skip, size refusal, Shopify's own errors, tenant isolation, buyer-fact normalisation |

A Shopify Function is a plain `(input) => output`; the CLI only wraps it in
WebAssembly. So the checkout logic is fully exercised here without a store —
what is _not_ exercised is the WASM build, the deploy, and the Admin API
accepting our mutations.

Because those mutations cannot be run without a store, the publisher tests pin
**the request** — mutation name, variables, metafield owner, namespace, key and
type — rather than a response we made up. That is the strongest guarantee
available before the dev-store run, and it will catch an accidental change to
what we send.

The API shapes were taken from Shopify's own published function examples and
sample app rather than from memory.

### 3. State walkthrough

No UI in this task. The Function's observable states are its outputs, and all
22 are asserted exactly. The Pricing page's states arrive with 1.3.

### 4. Cross-tenant check

- Publishing for one shop leaves another's `discountId` and `rulesetHash` null.
- All publisher reads and writes go through the scoped client, so a missing
  tenant throws rather than reading across shops.
- At checkout the boundary is Shopify's: a Function only ever sees one shop's
  discount, and the ruleset it reads is the metafield on that shop's own
  discount node.

### 5. The three musts

| Rule                                           | Status at 1.2                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | **Now load-bearing, and held.** The Function computes nothing: it builds a context per cart line and calls `resolvePrice`. A dedicated suite asserts that what the Function charges equals what the engine returns across percentage, fixed-price, stacked and rounding cases — the property that lets the Buyer Agent quote a price it can stand behind. |
| No AI mutation without an approval record      | Unchanged; no AI call sites yet.                                                                                                                                                                                                                                                                                                                          |
| No unhandled promise rejections in the e2e run | Unchanged and clean. The Function is synchronous and cannot reject; it also cannot throw, by design (§6).                                                                                                                                                                                                                                                 |

### 6. Design decisions worth calling out

- **The Function never throws.** One that fails applies no discounts at all, so
  every wholesale buyer in the store quietly pays retail until a human notices.
  Parsing never throws, the entry point catches everything, and one malformed
  rule costs that rule alone. Wrong-but-visible beats wrong-but-silent, and the
  shelf price is the visible failure.
- **Market-scoped rules are dropped at checkout, deliberately.** The Function
  knows the buyer's country but not which Shopify Market it maps to, and an
  `exclude` rule evaluated with no market id would match everywhere and hand out
  a discount the merchant had scoped away. Dropping is the safe direction; the
  Function warns, and 1.3 publishes the map.
- **An oversized ruleset fails rather than truncating.** Shopify caps a
  metafield, and a truncated ruleset means charging prices nobody configured.
  The publisher refuses over 48 KB and leaves the last good ruleset live.

### 7. Open items

- **BLOCKING for this task: the dev-store run has not happened.** Needed on
  `mannon-9iu9ewku.myshopify.com`, in this order: `shopify app deploy` to build
  and ship the Function; confirm the automatic discount appears; tag a customer
  `wholesale`; add the product to a cart as that customer; confirm checkout
  charges the engine's price. Until then the WASM build, the two Admin API
  mutations, and the metafield reads in the input query are unproven. This is
  the same gate as the Phase 0 walkthrough and needs the same session.
- **Nothing calls `publishRuleset` yet.** There is no rules table until 1.3, so
  the publisher has no trigger. Recorded in PROGRESS.md as a hard dependency:
  1.3 must call it after every rule save, or a saved rule will not exist at
  checkout.
- **Product collection metafields are not published yet.** Collection-targeted
  rules therefore will not apply at checkout even though the engine handles
  them and the admin will show them applying. Also a recorded 1.3 dependency —
  it needs a `products/update` handler and a backfill, which belongs with the
  task that lets merchants create such rules.
- **Correction to the record:** while updating PROGRESS.md this task I found
  that the 0.2 and 0.3 status rows had never actually been updated — two
  scripted edits failed silently against a Prettier-reformatted table and I did
  not verify them at the time. PROGRESS.md had been reporting 0.2 as not started
  and 0.3 as blocked for two commits. Corrected here.

---

## 1.3 — Pricing page: rule list, builder, priority and combinations

**Verdict: pass with open items.** Rules are stored, edited, ordered, explained
and published to checkout, and every state in checklist §2 is rendered and
asserted. Four deviations are deliberate and argued in ADR 0008; three gaps are
listed in §7.

### 1. Test plan

_Happy paths_

- Create, edit, archive, restore and permanently delete a rule.
- A saved rule reaches checkout; an archived one leaves it.
- Reordering rewrites priority in the order the merchant left.
- "Why this price?" runs the real engine over the real rules.

_States (checklist §2)_

- Rule list: empty, partial (no filter bar under three), ideal, no search
  results, cached, publish failed, at the plan's quota, archived-empty,
  paginated, and the badge set — missing targets, schedule countdown, duplicate
  name, unused, ended.
- Builder: new, field-level validation, overlapping tiers, live preview,
  preview unavailable, save conflict, duplicate-name warning.
- Settings: order with the combination warning, explain with reasons, explain
  with no matching rules, explain clamped at zero.
- Arabic for the list and the builder.

_Three invented abuse cases_

1. **Malformed input** — a rule with a blank name, a percentage of 150,
   overlapping tiers, an unparseable money amount, and a permanent delete whose
   typed confirmation does not match the rule's name.
2. **Concurrency** — two staff editing one rule: the second save is refused with
   the other person's version attached, and the row is unchanged.
3. **Wrong shop/tenant** — listing, fetching by id and archiving another shop's
   rule.

### 2. Automated tests

`npm test` — **383 passed** (26 files), up from 337. This task adds 46:

| Suite                                      | Cases | Covers                                                                                                                                                                                                          |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/pricing-rules.test.ts`  | 22    | Create/edit/archive/restore/delete, publish-on-save, database round trip, validation, plan quota, version conflict and forced overwrite, list ordering/search/pagination, reorder, three tenant-isolation cases |
| `tests/unit/pricing-pages-states.test.tsx` | 24    | Every §2 state above, in English and Arabic                                                                                                                                                                     |

Lint, typecheck and build clean.

### 3. State walkthrough

Twenty-three states captured to `qa/1.3/` (`npm run qa:capture`), covering the
list, the builder and the settings page in both languages.

Same caveat as 0.3, restated because it matters: these verify **which content
and which states render**. They are not a design review — Polaris cannot load
here, so the styling is a stand-in, and each capture says so.

### 4. Cross-tenant check

Three cases in the integration suite: another shop's rules are absent from the
list and from the engine ruleset, a fetch by id returns null, and an archive
attempt raises 404 while leaving the row untouched. The edit route's loader
turns that null into a 404, so the HTTP-level cross-tenant check carried since
0.1 is now closed.

### 5. The three musts

| Rule                                           | Status at 1.3                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No price from outside the pricing engine       | **Held, and now visible.** The live preview and "Why this price?" both call `resolvePrice`; the trace shown to the merchant is the engine's own. Saving publishes the same rules to checkout. There is no second pricing path. |
| No AI mutation without an approval record      | Unchanged. "✦ Describe a rule" is rendered but disabled, pointing at 4.2, rather than absent — the merchant should know it is coming.                                                                                          |
| No unhandled promise rejections in the e2e run | Unchanged and clean.                                                                                                                                                                                                           |

### 6. Bugs found and fixed

1. **`disabled={false}` renders as `disabled="false"`.** React stringifies props
   on custom elements, and a browser reads any present `disabled` attribute as
   disabled — so "Create rule" would have been permanently unclickable for every
   merchant not at their quota. Found by reading the rendered markup in a
   capture. Fixed with a helper that omits the attribute instead of setting it
   false, and every `s-*` boolean prop now goes through it.

2. **Rows leaked between integration tests.** `resetDatabase` had a
   hand-maintained table list that did not include `PricingRule`, so eleven
   unrelated assertions failed at once. Fixed by deriving the list from the
   Prisma DMMF — the same principle as the tenant guard: no registration step to
   forget.

3. **English plurals, again.** `missingTargets`, `startsIn`, `endsIn`,
   `unreadableHeading`, three target counts, three audience counts and
   `liveHeading` were all written as a bare key plus `_other`. The plural test
   from 0.3 caught all eleven before they shipped, which is the second time that
   test has paid for itself.

A fourth issue was in a test rather than the code: the pagination fixture had one
row but claimed a hundred and twenty, so it asserted "51–51 of 120" against a
correct "51–100 of 120". Fixed the fixture.

### 7. Open items

- **Market scoping is not offered in the builder.** The Function cannot evaluate
  it (ADR 0007) and the country-to-market map needs a Shopify Markets query that
  cannot be verified without a store. Withholding the control is the honest
  choice: a merchant cannot build a rule that the admin shows applying and
  checkout ignores. The engine and storage already support it.
- **Targets and audiences are typed as ids, not picked.** A merchant pasting
  product GIDs is not shippable UX; the fix is App Bridge's resource picker,
  which cannot be exercised outside the admin iframe. This is the largest
  remaining usability gap on the page and should be closed in the dev-store
  session.
- **The live preview updates on save, not per keystroke.** The checklist asks for
  300 ms. The engine is browser-safe, so this is a client-side wiring job rather
  than a design problem, but it is not done.
- **Usage counts are `null` until 6.1.** Rendered as an em dash with a
  screen-reader explanation, never as a zero — "not measured" and "zero" are
  different facts.
- **Unchanged and still blocking Phase 1:** the dev-store run from 1.2. Nothing
  in this task has been seen in the Shopify admin.

---

## 1.4 — CSV import and export

**Verdict: pass with open items.** Templates, upload, dry run, problem CSV,
import, undo and export all work and are covered. `.xlsx` is deliberately not
accepted (§7).

### 1. Test plan

_Happy paths_

- Download a template, fill it in, import it; export, edit, import back.
- Rows sharing a name become one rule with several quantity breaks.
- Import creates rules and publishes live ones to checkout.
- Undo removes exactly what the import created.

_States (checklist §2 CSV import)_

- Choose a file; file over 10 MB; over 50,000 rows; unreadable; unrecognised
  columns; dry run with counts; dry run with nothing importable; dry run that
  would be too big for checkout; imported with undo; undone; undo expired;
  Arabic.

_Three invented abuse cases_

1. **Malformed input** — a file that ends inside a quote, a BOM, CRLF, ragged
   rows, a stray quote mid-field, blank lines, an unknown rule type, a
   non-numeric priority, unparseable money, a bad date, and a 150% discount.
2. **Concurrency** — undo clicked twice, and undo after the window closed.
3. **Wrong shop/tenant** — undoing another shop's import.

### 2. Automated tests

`npm test` — **451 passed** (29 files), up from 383. This task adds 68:

| Suite                                      | Cases | Covers                                                                                                                                                                                                  |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/csv-parse.test.ts`             | 17    | Quotes, embedded commas and newlines, doubled quotes, CRLF, BOM, ragged rows, blank lines, trailing newline, a stray quote, empty file, unclosed quote, and a write/read round trip                     |
| `tests/unit/csv-plan.test.ts`              | 21    | Template detection, both templates, merchant spellings, SKU resolution, unknown SKUs listed, every issue code, zero-as-warning, duplicate names, last-wins, tier overlap, good rows surviving a bad one |
| `tests/integration/csv-import.test.ts`     | 19    | Import and publish, draft imports not published, batch quota check, audit entry, undo semantics and expiry, tenant isolation, the size guard, exact-match SKU lookup, export round trips                |
| `tests/unit/pricing-pages-states.test.tsx` | +11   | The eleven CSV states above                                                                                                                                                                             |

Lint, typecheck and build clean.

### 3. State walkthrough

Eleven states captured to `qa/1.4/`. Same caveat as before: these verify which
content and which states render, not how they look.

### 4. Cross-tenant check

Undoing another shop's import raises 404 and leaves its rules intact. Every
import read and write goes through the scoped client, and `RuleImport` and
`RuleImportDraft` both carry `shop`, so the scope guard covers them without a
registration step.

### 5. The three musts

| Rule                                           | Status at 1.4                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | Held. Imported rows are validated by `validateRule` and stored in the engine's wire shape; nothing computes a price here. |
| No AI mutation without an approval record      | Unchanged. The CSV whisperer (AI column mapping) is 4.3; this task is the manual path it will build on.                   |
| No unhandled promise rejections in the e2e run | Unchanged and clean.                                                                                                      |

### 6. Bugs found and fixed

1. **The confirm step could not have worked.** A browser does not resubmit a
   file input, so "Import 214 rules" would have posted without the file and
   returned 400. Caught by reasoning through the flow rather than by a test —
   the tests exercised the planner and the importer, not the round trip between
   them. Fixed by holding the upload in `RuleImportDraft` so confirm imports
   exactly the bytes that were checked.

2. **The downloaded template did not import.** Its example row referenced SKU
   `ABC-1`, which exists in no merchant's store, so a merchant downloading the
   template and importing it unchanged would meet an error on their first try.
   The test asserting the template round-trips caught it; the template was wrong,
   not the test. Both examples now target everything, and the SKU column
   explains itself.

3. **English plurals, a third time.** Six more count-bearing keys written bare
   instead of `_one`. Fixed, and the rule is now written down in the README next
   to the i18n section, since catching it three times means the guard works but
   the authoring habit did not.

A fourth was cosmetic and caught by reading a capture: the problem table's
section heading repeated its own column header ("Problem" above "Problem").

### 7. Open items

- **`.xlsx` is not accepted.** Checklist §2 puts it in the dropzone, but "upload
  any messy price sheet, even a supplier's Excel" is the CSV whisperer (4.3),
  where AI column mapping is what makes an arbitrary sheet meaningful. Accepting
  `.xlsx` here and then failing to read it would be worse than saying CSV.
- **Per-variant price lists do not fit.** A price list of any size becomes one
  rule per variant, and the published ruleset hits Shopify's metafield limit at
  roughly two hundred. The dry run now refuses with the numbers rather than
  letting an import half-land, but the real fix is a `price_list` rule kind
  holding many variant→price entries in one rule. That is an engine change and
  needs its own task — it also blocks demo persona 2 ("individual variant
  pricing") from working at any realistic size.
- **Import always creates, never updates.** Re-importing an edited export makes
  a second copy rather than updating the original. Matching on name would be the
  obvious next step, but it changes what undo has to restore, so it is a
  deliberate follow-up rather than a half-built merge.
- **Drafts are never pruned.** `RuleImportDraft` rows from abandoned uploads
  accumulate; deletion on use is implemented, expiry sweeping belongs with the
  retention jobs in 7.2.
- **Unchanged and still blocking Phase 1:** the dev-store run from 1.2.

---

## Task 2.1 — Customer sync, groups, tagging engine, buyers list

Reviewed as someone who did not write it and does not trust it.

### 1. Test plan

The spec: checklist §3 (pending approvals, approved-buyers list, customer
groups, ✦ segment builder) and pages-features §3. Pending approvals and the
approve/reject flows belong to 2.3, and the segment builder to 4.3; this task
owns the sync that everything else reads, the groups, the tagging engine, and
the buyers list with its states.

Happy paths: an install backfills an existing customer base; a webhook keeps
one buyer current; a merchant creates the starter tiers, moves a buyer between
them, edits tags, writes a note, marks someone tax-exempt; a tagging rule is
previewed and applied.

Invented abuse cases:

1. **Malformed input.** A `customers/update` payload with `total_spent: "not a
number"`, no id at all, or tags as a comma string with duplicate whitespace.
   A stored tag condition with an unknown operator, an unknown field, a string
   where an object belongs, and a country condition with an empty list.
2. **Concurrency.** The backfill and a webhook writing the same customer at the
   same instant. This is not hypothetical — the backfill pages through the whole
   store while webhooks keep arriving.
3. **Wrong shop.** Reading, moving, deleting and sweeping another shop's
   customers and groups by id; a webhook delivery for shop B landing while shop
   A's data is in scope.

### 2. Automated tests

`npm test` — **564 tests, 32 files, all passing** (451 at 1.4). New:

- `tests/unit/tagging.test.ts` (31) — the pure engine: every condition kind,
  currency refusal, the never-ordered case, priority ordering and its tie-break,
  determinism, non-mutation, defensive parsing, validation, and a purity check
  that reads the source and fails on a clock or a foreign import.
- `tests/integration/customers.test.ts` (45) — narrowing both payload shapes,
  idempotent upserts, the concurrency case, backfill paging and resumption,
  group CRUD with the delete guard, list filters and pagination, the four row
  actions, the plan gate, preview-equals-apply, and eight tenant-isolation
  cases.
- `tests/unit/customers-pages-states.test.tsx` (33) — every state below.
- `tests/unit/pricing-pages-states.test.tsx` (+3) — regressions for the two
  1.3 defects found here.

Playwright: **89 passing**, including 31 screenshots of the 2.1 captures.

Lint, `tsc --noEmit`, `npm run build` and `prettier --check` are clean.

### 3. State walkthrough

31 states rendered and captured to `qa/2.1/` (HTML + PNG). Buyers list: empty,
first sync with skeletons, syncing with rows already in, ideal, badges (at
risk / pending / tax-exempt / deleted in Shopify), no results, orphaned buyers,
stale, paginated, AI-not-ready. Groups: empty with starter tiers, ideal with a
tier flagged as having no pricing, the delete guard, duplicate handle, the
bundle page, the empty bundle, and a paginated member list. Buyer page: ideal,
unverified VAT, VAT required, deleted in Shopify. Auto-tagging: empty, locked,
ideal, preview, preview with nothing to do, a run with failures, a rule held
back for an unreadable condition, validation. Arabic: the buyers list and the
groups page, RTL, with the dual form checked.

The captures are structure only — no egress to Shopify's CDN, so `s-*` elements
never upgrade. Each capture says so at the top. Three of the bugs below were
found by looking at them.

### 4. Cross-tenant check

Eight cases, all holding: another shop's customer and group both read as
not found; deleting their group is refused with 404 and leaves it intact;
moving their customer into one of my groups is refused _before_ any Shopify
call is made; a webhook for shop B writes nothing into shop A; a tag sweep
examines only the shop it is scoped to. `Customer`, `CustomerGroup` and
`CustomerTagRule` all carry `shop`, so the scope guard picks them up from the
DMMF without a registration step.

### 5. The three musts

| Rule                                           | Status at 2.1                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | Held. The only money on these screens is Shopify's own lifetime total for a buyer, formatted with the engine's `formatMoney`. It is a historical fact, not a price this app computed. |
| No AI mutation without an approval record      | Held, and nothing here is AI. The ✦ segment builder is rendered disabled and the reorder-prediction chip is never emitted, because neither model exists yet.                          |
| No unhandled promise rejections in the e2e run | Clean. The only stack trace in the server log is the deliberate 404 test.                                                                                                             |

### 6. Bugs found and fixed

1. **`disabled={!view.aiAvailable}` would have killed the ✦ button the day the
   AI layer shipped.** React stringifies props on custom elements, so
   `disabled={false}` renders `disabled="false"` — and a browser reads any value
   as the attribute being set. The button reads correctly today only because
   `aiAvailable` is false. This is the exact bug 1.3 wrote a `whenDisabled`
   helper for, missed in the same file that defined the helper. The helper now
   lives in `app/components/boolean-attribute.ts` with `whenChecked` and
   `whenLoading` beside it, and a test asserts no `disabled="false"` reaches the
   markup — verified by reverting the fix and watching it fail.

2. **The combinations checkbox showed ticked on a rule that does not combine.**
   Same cause, live rather than latent: `checked={form.combinable}` renders
   `checked="false"`, so every non-combinable rule opened in the builder claimed
   it stacked with other discounts. On a control that decides whether two
   discounts apply to the same line. Found by grepping for the pattern behind
   bug 1 rather than by any test; now covered by one.

3. **Two columns headed "Group" in the buyers table.** Found by looking at
   `05-buyers-badges.png`. The row action column reused the same catalog key as
   the group column; it now reads "Change group".

4. **A deleted buyer's row promised a future price.** Also from the same
   capture: "New prices apply on this buyer's next visit to your store" rendered
   on a row marked deleted in Shopify, where no price applies at all.

5. **The group page showed the first fifty members and nothing else.** No
   pagination, in a codebase whose rule is that every list paginates. A tier
   with three hundred members would have looked like it had lost two hundred.

A sixth was in a test, not the code: the search test asserted that "gold" should
not match a company called "Goldsmith & Co". It should — company is a substring
search, and a merchant typing "gold" wants it. The property actually worth
holding is that a _tag_ match is whole, so "gold" does not return every buyer
tagged `goldsmith-only`; the test now says that instead.

### 7. Open items

- **Not seen in a real Shopify admin.** Unchanged from 1.2–1.4 and now spanning
  two phases. `shopify.dev` and `cdn.shopify.com` are blocked by org policy, so
  Polaris never upgrades and the embedded surfaces cannot be driven. Everything
  above is asserted markup, not a merchant's screen.
- **The Admin API calls are pinned, not exercised.** `tagsAdd`, `tagsRemove`,
  `customerUpdate(taxExempt)` and the customers query are asserted by the exact
  query and variables sent, against a fake. Their real behaviour — field names,
  the `numberOfOrders` string, whether `defaultAddress` is null for a customer
  with no address — is unverified without a store. The mapping is defensive
  about all three.
- **Shopify B2B companies are not modelled.** Pages-features §3 lists companies,
  locations and catalogs on Plus. Groups are Mannon's own tiers; the two need to
  be reconciled, which needs a Plus store to look at.
- **Approval status is a column with no pipeline.** `BuyerStatus` exists and the
  list renders PENDING and REJECTED, but nothing sets them until the approval
  pipeline lands in 2.3. Every synced customer is APPROVED, which is true —
  they can already place orders.
- **Auto-tagging has no schedule.** By decision, not omission — see ADR 0011.
  The merchant presses apply. A sweep that re-prices a customer base with nobody
  watching should not exist before the reporting to explain it does.
- **The tag rule builder takes one condition.** The engine handles many, `all`
  and `any`, and seven condition kinds; the form offers one condition of four
  kinds. The full editor is worth doing next to the ✦ segment builder in 4.3,
  which needs the same control.
- **`vatNumber` has no way in yet.** The column and the tax-exempt guard that
  reads it are here; the registration form that collects it and the VIES check
  that verifies it are 2.2.
- **At risk is a fixed 60 days**, not a per-customer cadence. Deliberate: a
  merchant has to be able to read the badge and know what it claims. The
  prediction version arrives with the AI layer and will be labelled as one.

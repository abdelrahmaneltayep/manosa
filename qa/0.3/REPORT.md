# QA report — 0.3 · Billing: plans, gate middleware, Plans page


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

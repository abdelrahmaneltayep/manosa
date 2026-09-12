# Cold read — 0.3 · Billing, plans and feature gating

**Verdict: FAIL.**

Reviewed on 2026-09-12 against `claude/mannon-b2b-wholesale-oc5b18` at `fd37e29`
(working tree carries one unrelated uncommitted change from a parallel review,
`app/lib/pricing/admin-graphql.server.ts`).

Two things fail it independently:

1. **A paid capability is given away and a lapsed plan pauses nothing.** CSV
   import has no gate at any layer, and every capability that reaches a buyer
   through a published Shopify metafield — pricing rules over quota, order
   limits, net-terms settings — keeps running after the subscription ends. The
   Plans page tells the merchant the opposite in so many words.
2. **Checklist §9 is not met.** The plan advisor, the export offered before a
   downgrade, the 3-day trial email and the one-click resume were deferred at
   0.3 "until the AI infrastructure / until there is data to export". Phases 1–7
   are done and none of them landed. The usage meters §9 asks for still return
   a hard-coded `0`.

Everything below was verified by running code, not by reading it. Repro tests
are in `qa/0.3/cold-read/`:

```bash
export TEST_DATABASE_URL='postgresql://mannon:mannon@localhost:5432/mannon_cr3?schema=public'
npx vitest run --config qa/0.3/cold-read/vitest.config.ts
```

Result: **9 failed, 2 passed** (F10 tenancy and nothing else passes). The
committed suite is green — `npx vitest run` → 125 files, 2253 tests, all
passing — which is the point: none of this is covered.

---

## P0 — a merchant is charged wrongly, loses what they paid for, or gets a paid feature free

### P0-1 · CSV import (Pro, $29) is not gated anywhere

`app/routes/app.pricing.csv.tsx` — loader and action both.
`app/lib/pricing/csv/import.server.ts:69` — the only check is the *row quota*.

`assertFeature("csv_import")` appears nowhere in the codebase. The string
`"csv_import"` occurs exactly twice outside `plans.ts`: once in an AI prompt
list, never in a gate. A Free shop can:

- download the templates and the full rule export (`?download=template`,
  `?download=export`, loader lines 74–84 — the export is every rule, page size
  5000);
- upload a file, have **Claude propose the column mapping** (line 317 — this
  spends the app owner's Anthropic budget for a non-paying shop), and import.

It is not even a disabled button: `app/components/pricing/RuleListPage.tsx:149`
links to `/app/pricing/csv` unconditionally, on every plan.

Verified — `qa/0.3/cold-read/gate.test.ts` F1: a shop with `planKey: "free"`,
for which `assertFeature("csv_import")` correctly throws, runs `runImport()` to
completion and creates the rule.

> This is the exact shape of the 6.5 lesson in CLAUDE.md, one step worse: there
> is no `allowed` boolean to be a courtesy in the first place.

### P0-2 · Nothing pauses when a subscription lapses

`app/lib/pricing/rules.server.ts:139` (`activeEngineRules`), and by extension
`republish` → the discount Function metafield.

`entitlementsFor` correctly drops `effectivePlan` to `free` on `CANCELLED`, and
Free allows one pricing rule. But the quota is only consulted on **create**.
Nothing truncates, unpublishes or re-publishes on a plan change, so a merchant
who cancels keeps all of their rules applying at checkout for ever. Same for
order limits (`extensions/mannon-limits` reads a published metafield;
`saveLimit` gates editing, nothing gates the published payload) and net-terms
settings (`publishTermsSettings`).

Verified — F3: five active rules, subscription set to `CANCELLED`,
`effectivePlan === "free"`, `limits.pricingRules === 1`, and
`activeEngineRules()` still returns **5** rules for publication.

The page says the opposite, in the merchant's own language:

- `plans.change.overageBody` — "they stay saved and **stop applying** until you
  move back up";
- `plans.cancelled.body` — "Paid features are paused".

Neither is true. That is invariant 4 ("nothing claims to have happened that did
not") as well as a giveaway.

Worst sub-case, `app/lib/terms/ledger.server.ts:64`: after a lapse, net terms
keep being *extended* to buyers at checkout, while `recordPayment` throws
`FeatureLockedError` — so the merchant can no longer record the money coming
in against invoices the app is still issuing. The credit half runs and the
collection half stops.

### P0-3 · An out-of-order subscription webhook drops a paying merchant to Free

`app/lib/webhooks/handlers/app-subscriptions-update.server.ts:57–77`.

The handler writes whatever the payload says with no reference to which
subscription the shop is actually on: it ignores `admin_graphql_api_id`,
ignores `created_at`, and does not compare against `existing.subscriptionId`.

An upgrade is precisely the case where Shopify emits two deliveries — the new
subscription becoming `ACTIVE` and the replaced one becoming `CANCELLED`.
Webhook ordering is not guaranteed. If the cancellation lands second, the shop
is set to `planKey: "free"`, `billingStatus: "CANCELLED"`, and the merchant who
has just been charged for Growth loses every paid feature — plus an audit line
saying "The pro subscription ended."

Nothing repairs it: the same handler sets `billingSyncedAt = now`, and the only
other refresh is the merchant opening the Plans page (see P1-3).

Verified — F4: deliver `growth-monthly/ACTIVE` (sub 2), then
`pro-monthly/CANCELLED` (sub 1). `loadEntitlements().effectivePlan` is `free`.
Both deliveries have distinct webhook ids, so the dispatch-layer idempotency
(which is sound) does not apply.

### P0-4 · An empty answer from `billing.check` cancels the plan and erases the grace period

`app/lib/billing/subscription.server.ts:144–196`, called unconditionally by
`app/routes/app.plans.tsx:38` on every Plans page load.

`snapshotFrom([])` returns `FREE_SNAPSHOT`, and `syncSubscription` writes it
straight onto the Shop row: `planKey: "free"`, `billingStatus: "NONE"`,
`graceEndsAt: null`, and an audit entry announcing the change that did not
happen.

An empty list is not a rare event. `@shopify/shopify-api`'s `check`
(`node_modules/@shopify/shopify-api/dist/cjs/lib/billing/check.js:64`) filters
`activeSubscriptions` by `plans.includes(subscription.name)` **and** by
`isTest || !subscription.test`. So all of these produce it:

- a billing plan id renamed or added without updating `PAID_BILLING_PLAN_IDS`
  (ADR 0005 calls this out and says the sync "refuses to act on a name it does
  not recognise" — it does not; `snapshotFrom:71-76` logs and then returns
  `FREE_SNAPSHOT`, which the comment three lines above says must never happen);
- `SHOPIFY_BILLING_TEST_MODE` flipped from `true` to `false`, which hides every
  existing test subscription;
- a frozen subscription, if Shopify's `activeSubscriptions` omits it — in which
  case a merchant inside the documented 7-day grace loses it the first time they
  open the page they were told to open to fix their card.

Verified — F5: shop on `growth`/`PAST_DUE` with `graceEndsAt` five days out,
one `syncSubscription` against `{ appSubscriptions: [] }`, and the row comes
back `planKey: "free"`, `graceEndsAt: null`.

### P0-5 · The $29 card sells the $59 plan's features

`app/i18n/locales/en.json` → `planTagline.pro` / `planTagline.growth` (and the
same swap in `ar.json`).

```
planTagline.pro    = "Net terms, shipping rules, draft orders, POS, Markets — and the Merchant Agent."
planTagline.growth = "Unlimited rules and forms, CSV import, auto-tagging and order limits."
```

The ladder in `plans.ts` puts **pro at $29 with CSV import / auto-tagging /
order limits / quick order**, and **growth at $59 with net terms / draft orders
/ the Merchant Agent**. ADR 0005 says that inversion is deliberate. The
catalogue was written from `docs/spec/pages-features.md:187-189` instead, where
the names are the other way round, and nobody reconciled them.

So on `/app/plans` the Pro card reads "$29/month · Net terms, shipping rules,
draft orders, POS, Markets — and the Merchant Agent", and the comparison table
immediately below it marks all six of those "Not included" for Pro. A merchant
who reads the card and subscribes has bought something they will not get.

Verified — F7 in `qa/0.3/cold-read/copy.test.ts`: `planTagline.pro` promises
`net_terms`, `shipping_rules`, `draft_orders`, `pos`, `markets`,
`merchant_agent`; `planHasFeature("pro", …)` is false for every one.

---

## P1 — broken feature

### P1-1 · The usage meters have never counted anything

`app/lib/billing/usage.server.ts:27-36` still returns `{ pricingRules: 0,
forms: 0 }` behind `TODO(phase 1.3)` and `TODO(phase 2.2)`. Both phases shipped
long ago; `db.pricingRule` and `db.registrationForm` exist.

Consequences, all merchant-visible:

- "Your usage · Pricing rules 0 of 1" on a shop with forty rules;
- the 80 % warning and the at-limit banner (checklist §9) can never fire;
- `app/routes/app.plans.tsx:26` feeds the same zeros into `planChangeFor`, so
  the downgrade impact preview — the thing CLAUDE.md requires to name what
  pauses — reports no overage for any downgrade, ever.

Verified — F2: three rules and one form created through the real code paths;
`usageFor("pricingRules")` returns `0`, `usageFor("forms")` returns `0`.

### P1-2 · The quota is racy at every call site

`app/lib/pricing/rules.server.ts:217`, `app/lib/forms/forms.server.ts:204` and
`:296`, `app/lib/pricing/csv/import.server.ts:68` all do
`count()` → `assertWithinLimit()` → `create()`, with the count **outside** the
transaction. ADR 0005 and the README specify the opposite, and
`gate.server.ts:78-83` documents exactly this race in its own docstring.

Verified — F6: two concurrent `createForm` calls on a Free shop, repeated ten
times; **nine of ten attempts created two forms** on a one-form plan
(per-attempt totals `1, 2, 2, 2, 2, 2, 2, 2, 2, 2`). `createForm` does not open
a transaction at all.

### P1-3 · Nothing reconciles the cached plan; the staleness check is dead code

`syncSubscriptionIfStale` (`subscription.server.ts:199`) has **no caller in
`app/`** — only tests. ADR 0005 lists it as one of three freshness mechanisms;
there are two, and one of them requires the merchant to open the Plans page.

So if the `app_subscriptions/update` delivery is lost (or was mangled by
P0-3), the cached plan is never corrected. The storefront surfaces that *do*
gate correctly — `proxy.agent.tsx`, `proxy.quick-order.tsx`,
`proxy.variants.tsx` — read that same cache, so a shop that cancelled keeps the
Buyer Agent and Quick Order until somebody opens `/app/plans`.

Verified — F11 (grep-based assertion).

### P1-4 · Four capabilities are sold on the comparison table and do not exist

`shipping_rules`, `quote_assistant`, `api_sync`, `priority_support` appear
nowhere in `app/`, `extensions/` or `packages/` outside `plans.ts` — verified by
F9. `pos` and `markets` occur only as an order-source label
(`orders/sync.server.ts:183`) and a rule-targeting dimension
(`rule-mapper.server.ts:129`); neither is a plan capability and neither is
gated.

`ComparisonTable` (`PlansPage.tsx:475`) renders every `FEATURE_KEY` with
"Included" against the plan, so Growth is sold on "Wholesale shipping rules"
and Agentic on "Quote drafting assistant", "API and ERP sync" and "Priority
support". Invariant 4.

### P1-5 · Checklist §9 items deferred at 0.3 and never built

- **Plan advisor** — still `AdvisorPlaceholder` (`PlansPage.tsx:500`), "coming
  soon". §9 requires it, including the no-dark-patterns requirement that it be
  able to say "stay on your plan".
- **Export offered before a downgrade** — not implemented. The string exists
  and is orphaned (`plans.change.exportFirst`, referenced by nothing).
- **Trial ending email at 3 days** — no such mail exists (`grep -ril trial
  app/lib/email app/lib/jobs` → nothing). The banner is in-app only, which is
  the one place a merchant whose trial is ending may not be looking.
- **One-click resume after cancellation** — `plans.cancelled.resume` is
  orphaned; the cancelled banner renders heading and body only.

### P1-6 · The trial banner quotes the wrong price to annual subscribers

`app/components/plans/PlansPage.tsx:99` passes `plan.monthlyPrice` into
`plans.trial.endingBody` — "After that, Agentic is $99 a month" — regardless of
`view.interval`. An annual trialist will be charged **$990 once**. Verified —
F8.

### P1-7 · The 14-day trial can be taken repeatedly

`shopify.server.ts:43` puts `trialDays: plan.trialDays` on all four paid billing
configs, and `app.plans.tsx:141` requests them unconditionally. Nothing records
that a shop has already had a trial. Cancel and resubscribe — or merely switch
monthly → annual, which the page invites via the interval toggle — and Shopify
issues another 14 free days.

### P1-8 · Two ✦ surfaces call the model with no plan gate

`app/routes/app.customers.segments.tsx:208` and
`app/routes/app.pricing.describe.tsx:130` call `requireAi("draft")` with no
`feature`. Every comparable surface passes one (`app._index.tsx:75`,
`settings.translations.tsx:79`, `i18n/fill.server.ts:78`,
`daily-briefing.server.ts:40` all require `merchant_agent`). Free shops
therefore reach Claude on the app owner's key through the segment builder and
the rule-describer.

### P1-9 · The webhook cannot express a trial, and leaves dates stale

`app-subscriptions-update.server.ts:93-106` maps `ACTIVE → ACTIVE` and never
`TRIAL`; it writes neither `trialEndsAt` nor `currentPeriodEnd`. Any delivery
during a trial therefore erases the trial state from the cache — no days-left
pill, no 3-day banner — until a Plans page sync restores it. On `CANCELLED` it
leaves the old `currentPeriodEnd` in place, which is what
`plans.change.takesEffectAtPeriodEnd` prints as a date the merchant "keeps"
their plan until.

---

## P2 — quality

1. **`npm run typecheck` is red on the committed tree**, independently of this
   review: `tests/integration/readiness.test.ts(177,17): error TS2339: Property
   'missingOptional' does not exist…` — the `...checks` spread in
   `app/routes/healthz.ready.tsx:67` is typed `Record<string, unknown>` and the
   inferred loader type loses the key. CI runs `typecheck` before `test`
   (`.github/workflows`, line 51), so the pipeline cannot currently be green.
   `npm run lint` is clean (the only error comes from another review's untracked
   file).
2. **`entitlementsFor` fails open**: `status === "PAST_DUE" && graceEndsAt !==
   null && …` (`entitlements.server.ts:73`). A `PAST_DUE` row whose
   `graceEndsAt` is null is never lapsed — unbounded paid access. Both writers
   happen to set it today; a gate should not depend on that.
3. **`SHOPIFY_BILLING_TEST_MODE` has no production guard and no per-shop
   notion.** `assertEnvironment` does not look at it. Set `true` on a
   production deployment and every merchant subscribes for free with a polite
   "no money changes hands" banner; set `false` and a development store cannot
   subscribe at all (Shopify refuses a live charge), which surfaces as the
   generic "We couldn't start that change". README:277 tells an operator to set
   it per-store, which a single multi-tenant deployment cannot do.
4. **Orphan i18n keys** in both catalogues: `plans.onPlan`,
   `plans.billedMonthly`, `plans.billedAnnually`, `plans.usage.pending`,
   `plans.usage.unlimited`, `plans.choose`, `plans.cancelled.resume`,
   `plans.change.exportFirst`. Three of them are §9 features that were never
   wired up (P1-5); the rest are dead weight the parity test does not catch.
5. **Count-bearing plan strings are interpolated without `count`**:
   `plans.usage.ofLimit`, `nearingBody`, `atBody`, `change.limitTightens`,
   `change.overageBody` all pass `used` / `limit` / `overBy`. CLAUDE.md requires
   count-bearing strings to be called with `count` and to carry plural
   categories; in Arabic these render ungrammatically for 1, 2 and 3–10.
6. **`snapshotFrom`'s comment contradicts its code** (`subscription.server.ts:68-76`).
7. **The quote expiry job** (`jobs/handlers/expire-quotes.server.ts`) mails quote
   reminders with no `draft_orders` check, so a lapsed shop keeps emailing
   buyers about a paused feature.

---

## What is sound

- **Tenancy.** Verified, not assumed — F10 passes: entitlements answer for the
  requesting tenant, and `db.shop.findUniqueOrThrow`/`update` for another shop's
  id throw `CrossTenantError` rather than leaking. The `Shop` model is picked up
  automatically by `shopScope`'s DMMF scan.
- **Webhook delivery idempotency** (`dispatch.server.ts`) — replays are no-ops,
  a failed attempt is resumed. Only *ordering* is unhandled (P0-3).
- **One catalogue.** `shopify.server.ts` derives the billing line items from
  `PLANS`, so the charge and the card price cannot drift. Annual = ten months
  at every tier; `annualSaving` matches.
- **Server-side gates that are real**: `po_to_order` (402 in the action),
  `buyer_agent` (both proxy verbs, the log export, the rehearsal),
  `quick_order`, `auto_tagging`, `order_limits`, `net_terms` and `draft_orders`
  all refuse in the service layer, not the view.
- **Downgrade mechanics**: `ApplyOnNextBillingCycle` on a downgrade, prorated
  credit on cancel, a downgrade reachable in the same number of clicks as an
  upgrade, no urgency or guilt copy. No dark patterns found in the copy that
  exists.
- **No billing secrets in the client bundle** (`build/client` carries no
  reference to `SHOPIFY_BILLING_TEST_MODE`, `syncSubscription` or any key).

---

## Re-run required

After the fixes, re-run the whole suite plus the repro file; the repro file
should then fail to fail. The two things it cannot prove and that still need the
dev store: a real `billing.request`/`billing.cancel` round trip, and whether
Shopify's `activeSubscriptions` includes a FROZEN subscription — the answer
decides whether P0-4 destroys the grace period on every Plans page load or only
on the config-drift paths.

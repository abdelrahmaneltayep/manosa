# Progress

Updated: 2026-09-19T06:20:00Z
Current milestone: 6 — Analytics
Current task: the P4s [done] — **there is no P4 severity band**; the two things
labelled P4 are a MEDIUM finding in 5.3's `P1`–`P17` list and a reproduction
probe in 6.1, both closed. The rung below P3 (5.3's and 6.1's LOW/NIT tail) was
audited in the same pass and three of 6.1's four were still open. **Every
finding in every cold read in `qa/` is now closed**, at every severity, with
the one exception noted against 6.5 #23 below, which cannot be fixed without
breaking `migrate deploy` and is documented instead. The outstanding blockers are unchanged and are
listed under _Blocked_ and in the notes below. The localhost URLs in
`shopify.app.toml` are now **one variable away** rather than five hand edits:
set `SHOPIFY_APP_URL` and run `npm run config:urls`. Nobody has said where this
app will be deployed, so that variable has no production value and
`release:check` still reports the blocker, correctly.

## Done

- [x] 0.1 Scaffold, auth, session storage, shop-scoped Prisma, CI — commit `f0567f4` — QA: `qa/0.1/REPORT.md`
- [x] 0.2 Webhook framework, audit log, i18n EN/AR — commit `832d79d` — QA: `qa/0.2/REPORT.md`
- [x] 0.3 Billing: plans, gate middleware, Plans page — commit `fb3590f` — QA: `qa/0.3/REPORT.md`
- [x] 1.1 `packages/pricing-engine`, golden vectors first — commit `95307e1` — QA: `qa/1.1/REPORT.md`
- [x] 1.2 Shopify discount Function wired to the engine — commit `ee84d34` — QA: `qa/1.2/REPORT.md`
- [x] 1.3 Pricing page: rule list, builder, priority, combinations — commit `33289ae` — QA: `qa/1.3/REPORT.md`
- [x] 1.4 CSV import and export, dry run and undo — commit `fa14f95` — QA: `qa/1.4/REPORT.md`
- [x] 2.1 Customer sync, groups, tagging engine, buyers list — commit `e4313ca` — QA: `qa/2.1/REPORT.md`
- [x] 2.2 Registration form builder, theme block, VIES, spam protection — commit `1206e68` — QA: `qa/2.2/REPORT.md`
- [x] 2.3 Approval pipeline: queue, decisions, emails, evaluator — commit `3e0c403` — QA: `qa/2.3/REPORT.md`
- [x] 3.1 Wholesale order list, order limits, quantity increments — commit `1722590` — QA: `qa/3.1/REPORT.md`
- [x] 3.2 Net terms: eligibility, pay later, ledger with aging, reminders — commit `3575495` — QA: `qa/3.2/REPORT.md`
- [x] 3.3 Quotes: pipeline, expiry, accept link, price locking — commit `c146e8a` — QA: `qa/3.3/REPORT.md`
- [x] 3.4 Quick order storefront blocks, signed App Proxy — commit `224e4a0` — QA: `qa/3.4/REPORT.md`
- [x] 4.1 AI infrastructure: client, streaming, timeouts, audit hooks — commit `b8136b5` — QA: `qa/4.1/REPORT.md`
- [x] 4.2 Rule-from-a-sentence, margin guard — commit `d45f02b` — QA: `qa/4.2/REPORT.md`
- [x] 4.3 Screening, drafted emails, segments, CSV whisperer — commit `be3c6d0` — QA: `qa/4.3/REPORT.md`
- [x] 4.4 Merchant Agent briefing, Ask Mannon bar, PO-to-order — commits `b073b74` + `e05190b` — QA: `qa/4.4/REPORT.md` (cold read returned FAIL on 17 findings; all fixed, gate re-run clean)
- [x] 4.5 Home assembled: KPI cards, setup checklist, activity log, ✦ Setup Wizard — commits `ef73ee3` + `5ca4e1d` — QA: `qa/4.5/REPORT.md` (cold read returned FAIL on 15 findings incl. 3 P0s; all fixed, gate re-run clean — `qa/4.5/COLD-READ.md`)
- [x] 5.1 ✦ Buyer Agent server: guardrails, closed tool vocabulary, one turn — commits `47db22b` + `b86ea2b` — QA: `qa/5.1/REPORT.md` (cold read returned FAIL; the price guard was replaced, not patched — `qa/5.1/COLD-READ.md`)
- [x] 5.2 Buyer Agent chat widget (theme app block), Arabic storefront locale — commit `d2b49f2` — QA: in `qa/3.4/` captures 40–50
- [x] 5.3 Guardrails panel, test mode, conversation log, publish flow — commits `baeb811` + fix round — QA: `qa/5.3/REPORT.md` (cold read returned FAIL on 17 findings; the worst was that "Take over" recorded a merchant's reply with no route to the buyer while both sides were told it arrived — `qa/5.3/COLD-READ.md`. All fixed, gate re-run clean.)
- [x] 6.1 Order lines mirrored, with discount allocations — commits `1c2cafb` + fix round — QA: `qa/6.1/REPORT.md` (cold read returned FAIL on 7 findings: revenue over-reported after any refund, a truncation flag that could never be true, and a query ~100× over Shopify's cost ceiling. All fixed — `qa/6.1/COLD-READ.md`.)
- [x] shop facts — the store's own currency and timezone are finally read from Shopify — commit `0dbc09a` (they never had been; every money figure fell back to USD)
- [x] 6.2 the Analytics page — seven charts, their states, CSV per chart, the currency/timezone footer — commits `ad7a048` + fix round — QA: `qa/6.2/REPORT.md` (cold read returned FAIL on 20 findings, 3 of them P0 — `qa/6.2/COLD-READ.md`. All fixed; 16 captures from 13 distinct renders.)
- [x] 6.3 ✦ ask-your-data + ✦ monthly review — commits `7a05849` + this one — QA: `qa/6.3/REPORT.md` (cold read returned FAIL on 22 findings, 2 P0 — the answer's citation rendered a raw i18n key for three of seven charts, and the review re-introduced the refund double-subtraction in a figure kept forever. All fixed, gate re-run clean — `qa/6.3/COLD-READ.md`. 17 captures; `docs/adr/0025`. The gate's own step 3 had separately found `11-review-why.png` byte-identical to `10-review.png`, and chasing that found the same defect in 1.3, 2.3, 3.2, 4.4 and 6.2 — one a real product bug — so a guard now fails any two captures in a set that render the same.)

- [x] 6.4 Settings, part one — sections with a save bar each, wholesale tags, display, discount combinations, tax, orders and quotes, notifications with sender verification, danger zone — commits `cf22fd7` + fix round — QA: `qa/6.4/REPORT.md` (cold read returned FAIL on 23 findings, 1 P0 — the Notifications section could not be saved at all, because its Verify form was nested inside the section's form. All fixed — `qa/6.4/COLD-READ.md`. Also found `pausedAt` had existed since 0.1 and stopped nothing at checkout; `docs/adr/0026`. Six `Shop` columns a merchant could not change are now editable. The capture stand-in had no rule for `details` or `checked`, so field help text and checkbox state were invisible in **every** capture in the repo.)

- [x] 6.5 ✦ Agent controls — permission toggles wired through every ✦ surface, brand-voice samples, the muted-briefing list, the audit log filterable by actor/action/date, and the twelve-month retention job — commit `5babb43` + fix round — QA: `qa/6.5/REPORT.md` (cold read returned FAIL on 25 findings, 1 P0 — **the gate did not gate the POST**: every call site put `aiGate(...).allowed` in a _view_ and never read it as a condition, so four ✦ surfaces still called Claude after a merchant switched it off. All fixed — `qa/6.5/COLD-READ.md`. `docs/adr/0027`. **There was no AI permission control anywhere before this** — every ✦ surface gated on `isAiAvailable()` alone — and **nothing enforced the audit retention** the schema has promised since 0.2.)

- [x] 6.6 Translations — every buyer-facing string editable per language, ✦ wording suggested in the merchant's own voice, a review flag per string, export **and** import — commit `2ecabba` — QA: `qa/6.6/REPORT.md` (`docs/adr/0028`). The ✦ half nearly shipped inert for the fourth time: both catalogues ship complete, so "fill what is missing" would have had nothing to do on any store. It suggests wording over the strings a merchant has **not** written instead, which is also the first thing to read the 6.5 brand-voice samples. `StorefrontString` was not in the uninstall purge — the lesson from 6.4, applied before the cold read this time. **The cold read still returned FAIL on four P0s** (`qa/6.6/COLD-READ.md`), the worst a cross-tenant leak _outbound to buyers_: `addResource` writes into the object it is handed, so one shop's saved string rewrote the shipped catalogue for the whole process. Fixed in `aac76e3`: overrides are their own i18next namespace; the editable set is now ~50 genuinely buyer-facing keys rather than 534 mostly-admin ones; the checkout message is editable for real; an ✦ suggestion no longer reaches a buyer before a person accepts it; the page is one form with a save bar.

- [x] 6.7 (part) Orders over time — an eighth chart, counts not money, with its own whole-number axis — commit `7dcd13e` — QA: `qa/6.7/REPORT.md`. Closes the `pages-features.md` §7 line deferred at 6.2. The ✦ chart menu was a hand-kept list **inside the prompt**: adding a chart to `CHART_KEYS` satisfied the validator while the model was never told it existed, so nothing could route to it. Generated from an exhaustive record now, with a test.

- [x] 6.7 (part two) The three things that were registered and never built — the reorder chip (hardcoded `false` since 2.1), the net-terms risk signal (`terms_risk`: a prompt version, no prompt, no caller, no screen) and the widget greeting's tier and last order (open since 5.2) — commit `e9b2703` — QA: `qa/6.7/REPORT.md`. **Neither chip needed a model**: both are arithmetic on rows this app already stores, so `reorder_prediction` and `terms_risk` are deleted from the AI registry rather than left as names for features that do not exist. Found on the way: the Buyer Agent block was at **99.2% of its byte budget** because the guard counted `{% comment %}` and `{% schema %}`, neither of which Shopify ever serves — so the budget was pushing against documenting storefront code.

- [x] 7.2 (part) Privacy — Shopify's three mandatory topics (`customers/data_request`, `customers/redact`, `shop/redact`), which this app subscribed to **none** of, and a shop purge that finally reaches the buyers — commit `89de3d3` — QA: `qa/7.2/REPORT.md`. The purge cleared the _merchant's_ two contact fields and left every buyer's name, address, phone, VAT number, form answers, uploaded documents and every message sent to them behind, under copy promising deletion within 48 hours. **The cold read returned FAIL on three P0s and seven P1s** (`qa/7.2/COLD-READ.md`) — fixed in `390523c`. The worst: `shop/redact` wrote the very `uninstalledAt` the purge checks before deleting, so one delivery for a shop whose uninstall we had missed wiped a **live, trading merchant**; a reinstall never cleared `piiPurgedAt`, so a shop that had ever been purged could never be purged again; and the three topics were declared as `topics` rather than `compliance_topics`, which means Shopify is never told where to send them and the whole feature ships inert. Plus the retention sweep for the five tables that only ever grew.

- [x] 7.1 A deployment that says what is wrong with it — a boot-time environment check, `/healthz/ready`, and a drift guard holding the variable list, the code and `.env.example` together — commit `806d591` — QA: `qa/7.1/REPORT.md`. **The app booted happily without `SHOPIFY_API_SECRET`**, which does not refuse a webhook — it verifies it against an empty key, so a forged delivery for any shop is accepted. And **nothing anywhere said the job runner had stopped**: every promise this app makes on a schedule, the 48-hour GDPR purge included, runs only because an external cron POSTs `/internal/jobs/run`, and a cron that is never set up looks exactly like one that is. The drift guard found `SHOPIFY_DISCOUNT_FUNCTION_ID` documented nowhere — without it wholesale prices are right in the admin and never applied at checkout.

- [x] 7.3 Submission readiness — `npm run release:check` — commit `80daff7` — QA: `qa/7.3/REPORT.md`. **Shopify's own self-review requirements could not be fetched**: `shopify.dev` is blocked by this environment's network policy (`shopify doc fetch` → 403), and the skill that runs that review says never to work from a remembered list. So this is explicitly _not_ a compliance report — it is the subset a machine can check from inside the repo. It found one real blocker: every URL in `shopify.app.toml` is still `https://localhost:3000`, which Shopify calls for OAuth, webhooks and the App Proxy, so a submission on that file is rejected before anybody reads the listing. Known since 3.4 and never checked.

- [x] **The four pricing P0s** from `qa/1.1-1.2/COLD-READ.md` — commit `a3c25fc` — QA: `qa/pricing-p0/REPORT.md` (`docs/adr/0029`). The two worst were one root cause in two directions: **nothing taught anything outside the checkout Function which collections a product is in.** (1) `$app:mannon.collections` was written only by two webhooks, both of which fire on _change_, so a store installing with an existing catalogue sent every product to checkout with no collections — and _"20% off everything except Sale"_ then discounts exactly the products the merchant protected. There is a `products.backfill` job now, and the Pricing page says so while it runs. (2) `pricing.server.ts` hardcoded `collectionIds: []` in the **one** function that prices quick order, quotes, the Buyer Agent and PO-to-order: the block showed $8.00 and checkout charged $10.00, and a quote locked the wrong number for ever. Every surface now reads the _same metafield the Function reads_, and the field is required so no caller can forget. (3) `parseMoney` threw on `"1000.0"`, which is how Shopify serialises a **¥1,000** line — so every wholesale buyer in a zero-decimal-currency store paid retail, silently, for ever; and one odd amount cost the whole cart its discounts rather than one line. (4) The automatic discount was created with **no `discountClasses`** while the Function's first line refuses everything without `PRODUCT` — a discount that ran on every cart and was permitted to produce nothing. Found in passing, same class: order limits read the cart with a hardcoded `× 100`, so a ¥1,000 minimum passed a ¥1,000 cart on every yen store.

- [x] **The five billing P0s** from `qa/0.3/COLD-READ.md` — commit `cfc149d` — QA: `qa/billing-p0/REPORT.md` (`docs/adr/0030`). (1) **CSV import was gated nowhere at all** — `assertFeature("csv_import")` appeared nowhere in the codebase, so a Free shop could export every rule it had, have Claude map its columns on the app owner's key, and import; the link rendered on every plan. Now refused in the service layer, in the action before anything is parsed or sent to the model, and in the loader (which covers the two downloads). (2) **Nothing paused when a subscription lapsed.** The gate refused every _admin_ action correctly while three capabilities went on reaching buyers through metafields Shopify evaluates without asking us: over-quota pricing rules kept pricing, order limits kept blocking carts, and net terms kept being **extended** while `recordPayment` refused the merchant the ability to record the money coming in against invoices this app was still issuing — the credit half ran and the collection half stopped. Each publisher now asks what the effective plan allows, and `billing.reconcile` runs them the moment the answer changes, in both directions. Nothing is deleted. (3) **An out-of-order webhook dropped a paying merchant to Free** — an upgrade is exactly when Shopify sends two deliveries whose order is not guaranteed, and a cancellation landing second wrote Free over a merchant charged minutes earlier. (4) **An empty `billing.check` cancelled the plan and erased the grace period** on every Plans page load — and an empty list is not a cancellation: a renamed plan, a flipped test-mode flag or a frozen subscription all produce one. (5) **The $29 card sold the $59 plan's features**, with the table below it marking all six Not included; the hand-written taglines are deleted and each card composes its line from the ladder. Also: the usage meters had returned a hard-coded `0` since 0.3, so the downgrade preview reported no overage for any downgrade, ever.

- [x] **The twelve pricing P1s** from `qa/1.1-1.2/COLD-READ.md` — commit `82b9aa0` — QA: `qa/pricing-p1/REPORT.md` (`docs/adr/0031`). Ten fixed, one built as a feature, one recorded as a deliberate gap. The money one: **the cascade multiplied in float**, so every percentage whose exact answer landed on a half-cent tie landed just below it and `half_up` rounded it down — 13,636 measured wrong answers, every one a cent in the buyer's favour, for ever. The running price is an exact integer fraction now and 39.8M brute-forced cases agree with exact half-up. Also: **"Why this price?" answered with a context checkout never sees** (no groups, no company, no collections, the unit price as the cart subtotal — four of six audience modes wrong while the route said "this answer is the checkout answer"); **schedules were a day early** and the shop's timezone, populated and used by every analytics surface, was used by none of the pricing ones; **a later combinable rule overwrote a negotiated contract price upward**, reporting both as applied; **a rule pricing above the shelf price** was honoured by the preview, the quote and the agent and silently dropped at checkout; **a buyer checking out in EUR lost exactly their contract prices** and kept the percentage discounts, with no field anywhere to price a second currency — there is one now; **a ruleset format bump would have charged every buyer on every store retail** the day anybody made it; the unreadable-rules banner was wired to a hardcoded `0`; "checkout did not update" was a one-shot query parameter; the buyer backfill published only the one configured tag, so a rule targeting `gold` priced its buyers at retail until somebody edited them; and the Function read its own sandbox clock instead of the store's. **Market scoping stays unbuilt on purpose** — the Function knows the buyer's country, not their Market, so a scoped rule would be dropped at checkout while the admin showed it applying; the parser refuses one and a test names the unblocker.

- [x] **The app's own URL, from one place** — commit `ab3380c` — QA: `qa/app-urls/REPORT.md`. The standing blocker since 3.4 was stated as "the URLs are wrong"; that is the symptom. The defect was that the app's origin was **five strings a person had to remember to change together**, in a file the Shopify CLI rewrites on every `shopify app dev` — so anything hand-typed there is one dev run from being replaced by a tunnel URL. `SHOPIFY_APP_URL` already existed, was already required to boot, and was already what the running app used for these exact callbacks; the file was the only thing that disagreed. `npm run config:urls` now writes all five from it (`npm run deploy` runs it first), moving **only the origin** so `/auth/callback` and `/proxy` cannot be dropped, and refusing http, a development host, a URL with a path, or a non-URL — writing nothing rather than a config that looks deployed and is not. `submission.server.ts` and the rewriter share one scanner, so the check that reports a wrong URL and the command that fixes it cannot disagree about which URLs exist. **No hostname was invented**: nothing has been deployed and a plausible-looking wrong origin is worse than an obviously-local one.

- [x] **The P4s — and the LOW/NIT rung below P3** — commit `8ee8492` — QA: `qa/p4/REPORT.md`. There is no P4 band: 5.3's "P4" is a MEDIUM finding in a `P1`–`P17` list (the agent publish action had no plan gate — closed) and 6.1's is a reproduction probe (closed). The rung below P3 was audited instead: all ten of 5.3's LOW/NITs are genuinely closed; three of 6.1's four were not. **`OrderLine` stored money with no currency** — the model header stated the join requirement and the reviewer read that line and filed the finding anyway, because a comment is not a guard; there is a `currencyCode` column now, backfilled, with the `DEFAULT ''` dropped in the same migration so a future insert cannot write an empty one, taken from the currency the amounts were parsed in rather than copied from the order. **The one multiplication was the one unguarded number** — `1e15 × $10.00` threw straight out of `factsFromWebhook`, the one reader written so every malformed field fails soft, and a webhook that throws is an order that never mirrors because Shopify redelivers it to fail the same way; `lineTotal()` fails soft and logs, as `parseShopifyMoney` does. And **`///` comments in TypeScript**, where they reach no hover and no signature — 14 more than the finding named, three of them written by me in earlier rounds of this sequence.

- [x] **The P3s**, across all thirteen cold reads — commit `4066f7d` — QA: `qa/p3/REPORT.md`. Twenty-three of twenty-seven were already closed and were re-derived from the source rather than taken on the word of the line claiming it; four were open. **A setting and the entry that says who changed it were two awaits** (6.4 P3-5) — so was the pause flag, which is the most consequential control on the page; both are one transaction now, while `resumeApp`'s pair stays deliberately split because the publish sits between them and the entry states a number the publish produces. **An inverted date range on the activity log showed an empty page** (6.5 #22), which a merchant reads as a fact about their store rather than about what they typed; it now says so beside the field and in the empty state. **The one form on Settings with no unsaved-changes guard** (6.5 #24) was the one a merchant pastes a 4,000-character email into. And **6.5 #23 cannot be fixed**: editing an applied migration fails `migrate deploy` on every environment that ran it, so `prisma/migrations/README.md` explains instead why `Shop.aiMayAutoApprove` appears in the history and never existed.

- [x] **Tenancy P2-8** from `qa/0.1/COLD-READ.md` — commit `c9eebb9` — QA: `qa/tenancy-p2/REPORT.md`. The deferral that caused two P0s is closed. `tests/integration/tenant-relations.test.ts` is 65 tests: seven ways out of a tenant, probed across **every** scoped model that owns a relation, with two DMMF-driven tests that fail the day a tenth relation is added without a probe — and, for each, a check that the owning tenant can still do all of it. It found that the extension does not walk a nested `create` inside an `update`: that path is held by the composite `(shop, parentId)` foreign key on every owned relation, which is now asserted per relation instead of assumed. Four documents that claimed a wider guarantee than exists were corrected: `CLAUDE.md` invariant 2, ADR 0002's "any Prisma operation", `qa/0.1/REPORT.md` §4 (amended in place and dated — six assertions, all against the one model with no relations), and the "No relations exist yet" comment that stayed true in the comment and false in the schema for eighteen tasks.

- [x] **The five billing P2s** from `qa/0.3/COLD-READ.md` — commit `d8f2454` — QA: `qa/billing-p2/REPORT.md`. **`entitlementsFor` failed open**: a `PAST_DUE` row with no `graceEndsAt` was never lapsed, so paid capability was unbounded the day either writer stopped setting it. **`SHOPIFY_BILLING_TEST_MODE` was one variable for a whole process**, and the README told operators to set it per store — `true` bills every merchant in the tenancy nothing, `false` refuses every development store a subscription behind "We couldn't start that change". The store answers for itself now (`shop.plan.partnerDevelopment` → `Shop.isDevelopmentStore`), the variable is a developer's override, and a production process refuses to start with it set. **The quote expiry job mailed buyers about a paused feature**: expiring still runs on every plan (it only takes a promise away), reminding does not, and `remindedAt` is not stamped for a reminder that was never sent. Plus the two i18n ones: **five plan strings put a bare number where a noun belongs** ("The Free plan allows 1", which cannot agree in Arabic), and **the catalogue is a total map now** — `tests/unit/i18n-orphans.test.ts` found 37 orphans where the cold read named 8; 13 superseded ones deleted, 24 kept with the missing control written down.

- [x] **The five pricing P2s** from `qa/1.1-1.2/COLD-READ.md` — commit `07c27b8` — QA: `qa/pricing-p2/REPORT.md`. **The margin guard never evaluated a cart-value rule**: it priced every candidate with `cartSubtotal: null`, so the rule came back `cart_unknown` and the variant was counted "not applicable" — the guard's way of saying "nothing to warn you about" — on a rule selling below cost. Each tier's threshold is a checkpoint now, and never a cart smaller than the line inside it. **"Add 8 more units" was priced in a cart that cannot hold them**: the next-tier quote changed the quantity and kept the current subtotal. **Checkout named one rule of a stack**, so a buyer whose price moved twice read one reason. And two tests that could not fail: **every golden vector bypassed the codec** (all 41 passed against a `serializeRule` that drops `excludeCollectionIds` — the field P0-1 turned on), and the vector titled "rounding happens once at the end, not per rule" **listed a single rule**, which makes the two behaviours identical by construction.

- [x] **The billing P1s** from `qa/0.3/COLD-READ.md` — commit `42bdd05` — QA: `qa/billing-p1/REPORT.md`. Eight fixed (P1-1 went with the P0s), one §9 item deferred with the reason stated. **The quota was racy at every call site** — two concurrent creates produced two forms on a one-form plan on nine of ten measured attempts; `createWithinLimit` now takes the count and the insert in one transaction behind a per-shop advisory lock, because READ COMMITTED alone does not stop two transactions counting the same rows. **`syncSubscriptionIfStale` had no caller outside its own tests**, so a lost webhook was never repaired and the storefront surfaces reading that cache kept working for a shop that had cancelled; it runs from the `/app` layout now. **Four capabilities were rendered "Included" and exist nowhere in the codebase** — Growth sold on shipping rules, Agentic on an API and priority support; they are `PLANNED_FEATURES` now, with a third column answer and a note saying the merchant is not paying for them today. **Twenty ✦ call sites reached Claude with no plan gate** (the cold read found two; making `feature` required on `aiGate`/`requireAi` found twenty) — a Free shop could use the segment builder, the rule-describer and the CSV column mapper on the app owner's key. **The 14-day trial could be taken repeatedly** — cancel and resubscribe, or just flip the monthly/annual toggle, and Shopify issued another fortnight. **The trial banner quoted `monthlyPrice` to annual subscribers**, so somebody about to be charged $990 once read "$99 a month". **A webhook during a trial erased the trial from the cache** and a cancellation left a stale period end, which the page prints as the date the merchant keeps their plan until. Plus three §9 items that had been strings with nothing rendering them: one-click resume, the export offered before a downgrade, and the trial-ending email — which did not exist at all, so the only warning was a banner on the page a merchant has no reason to open.

## Next up

- **API keys were not in 6.6, and the reason matters.** §8 lists "public API
  keys, webhooks, ERP sync". **There is no public API.** All 53 routes are the
  admin, the App Proxy, two public-by-design pages (`f.$publicId`,
  `q.$publicId`), Shopify's inbound `webhooks.$`, a bearer-token
  `internal.jobs.run`, and `healthz`. A keys page would issue credentials that
  authenticate nothing — a merchant could create a key, paste it into an ERP,
  and get 404 on every call. That is the `taxExemptNeedsApproval` mistake
  (6.4, caught by the cold read) and the auto-approve toggle (6.5, avoided) a
  third time. A read API is its own task: auth, scopes, rate limits,
  versioning, pagination. Then the keys page.
- 6.7 polish — the rest; see `DECISIONS.md` for the splits
- 7.1–7.3 Release

## Blocked

- **Everything admin-facing, for visual verification** — `shopify.dev` and
  `cdn.shopify.com` are unreachable from this environment (org network policy),
  so Polaris `s-*` elements never upgrade and no admin screen has ever been seen
  as a merchant sees it. **Unblocker:** network egress to those two hosts, or a
  session on `mannon-9iu9ewku.myshopify.com`. Meanwhile: every screen is a
  props-only component whose states are rendered and captured to `qa/<task>/`.
  Not blocking any task — 0.1 through 2.3 all shipped — but nothing in the admin
  has a visual pass.
- **No Lighthouse run on the storefront blocks** (3.4) — needs a real
  storefront. Everything that would spend the ≤10-point budget is enforced by
  `tests/unit/storefront-blocks.test.ts` (no external script, no library, under
  16KB, nothing fetched before the table is near the viewport), but the number
  itself is unverified.
- **The App Proxy has never received a request from Shopify.** The signature
  scheme is implemented from the documented algorithm and tested both ways. The
  `[app_proxy]` url in `shopify.app.toml` points at localhost until
  `SHOPIFY_APP_URL` is set and `npm run config:urls` runs — it is one of the
  five URLs that command writes, and no longer something to remember
  separately.
- **`shopify app deploy` and the dev-store run** — same unblocker. The discount
  Function has never run at a real checkout, the theme block has never rendered
  in a real theme, and the Admin API mutations are asserted by request shape
  against fakes rather than exercised. Carried since 1.2.
- **Nothing scans uploaded files.** Needs a virus-scanning service. Until then
  `FormUpload.scannedAt` stays null and the admin says "not virus-scanned"
  rather than implying otherwise. Downloads are attachments, `nosniff`,
  sandboxed, behind the admin session.
- **No email has actually been sent.** The transport is real (Resend over HTTP,
  or `MANNON_EMAIL_TRANSPORT=log`), but there is no `MANNON_RESEND_API_KEY` here.
  **Unblocker:** that key. The request shape is asserted; the response is not.
  Every message the app would send is recorded in `EmailMessage` either way.
- **No unit cost has ever been read from a real store.** The margin guard reads
  `inventoryItem.unitCost`, which needs `read_inventory` — added to the scopes
  in 4.2, so **every existing install must re-authorize**. Until a dev-store
  session exists, the query shape and the minor-unit conversion are pinned
  against a fake admin and nothing else. With the scope missing the guard says
  "costs could not be checked", which is the right thing for it to say.
- **No briefing has ever been written by Claude, and no purchase order read.**
  Both need the key. The facts a briefing points at are computed and tested;
  the model's part is driven through an injected client.
- **`ANTHROPIC_API_KEY` is not set.** The 4.1 infrastructure is built and
  tested against an injected stub, and the product works without a key — but
  **no call has ever been made to Anthropic**, so no prompt in this app has
  ever been answered. Unblocker: that key. Blocks verification, not work.
- **No application has ever been screened for real.** ✦ Screening needs both a
  key and a dev store. The facts assembly, the closed signal vocabulary and the
  three "we could not say" states are tested against an injected client.
- **The model is `claude-sonnet-4-5`**, which the spec names and which is a
  previous generation (`claude-sonnet-5` is the current equivalent). One
  environment variable, `MANNON_AI_MODEL`. Flagged in `DECISIONS.md` rather
  than silently upgraded — worth confirming with the user.

## Deferred on purpose, with the task that owns them

- **GDPR mandatory webhooks** (`customers/data_request`, `customers/redact`,
  `shop/redact`) → 7.2. The framework and the job runner take each as a few
  lines. **This is app-review blocking** — it cannot slip past 7.2.
- **Retention jobs** → 7.2: `WebhookDelivery`, `FormEvent`, `EmailMessage`,
  `RuleImportDraft`, archived `PricingRule`s past 30 days, and the 12-month
  `AuditLog` window the checklist specifies.
- **Per-variant price lists** → needs a `price_list` rule kind in the engine.
  One rule per variant blows the 48KB metafield limit at roughly two hundred
  variants. Blocks demo persona 2 in 7.1.
- **Market scoping in the rule builder** → needs the Shopify Markets query,
  which needs a store. The engine and storage support it; only the control is
  withheld, so the admin cannot show a rule applying that checkout ignores.
  Order limits sidestep this: the validation Function is handed a country code
  directly, so limits are scoped by country (`docs/adr/0014`).
- **Editable limit and terms messages** → 6.2, Settings → Limit display.
  `DEFAULT_MESSAGES` and the reminder template ship English only; both already
  carry the numbers that make them useful. The pay-later button's name is built
  by the Function itself, which has no ICU, so it is English there too.
- **✦ Net-terms risk signal** → 4.3. No chip is shown until the model exists.
- **✦ Quote suggested response and margin-floor check** → 4.x. The section is on
  the quote page, disabled, and says so.
- **Editing a quote line's quantity in place** → a merchant removes and re-adds
  it. A per-row quantity field is the obvious next increment; left out rather
  than shipped half-wired.
- **Automatic payment reminders** → the `autoRemind` opt-in is stored per buyer
  and read by nothing; every reminder is sent by a merchant clicking a button,
  which is the checklist's default anyway.
- **Orders older than 60 days** → `read_orders` reaches no further without
  `read_all_orders`, a review-time grant. The list states its window on the page.
- **Plans page: discount-code field, ✦ Plan Advisor, export-on-downgrade** →
  0.3 deferred the first two (redemption tracking; AI infrastructure); the third
  now has something to export and can land with 6.2.
- **Shopify B2B companies (Plus)** — locations and catalogs. Mannon's groups are
  its own tiers; reconciling them needs a Plus store to look at.
- **`.xlsx` import** → 4.3, with the CSV whisperer that makes an arbitrary sheet
  meaningful. **Multi-step form pages, address autocomplete, QR codes** → each
  needs a second place to resolve conditional visibility, or a third-party
  service.

## Open questions for the user

Neither is blocking; both would change product decisions if answered.

1. **Product framing.** `docs/spec/brand.md` describes a narrower quote →
   counter → accept → reorder product that "rides Shopify's native B2B and
   prices on draft orders — it never rebuilds tax, totals, or checkout". The
   other three specs describe a full wholesale-pricing suite, and 1.2 built a
   discount Function that prices at checkout. The build follows the three specs.
   See `DECISIONS.md`, 2026-09-07.
2. **Repository name.** The repo is `manosa`; the product is Mannon throughout.

## Notes for my next self

- **An optional field on a gate is a list of who remembered.** `aiGate` took an
  optional `feature` and twenty call sites left it out. The cold read found two
  by reading; making the field required found all twenty in one `tsc` run. Same
  lesson as `collectionIds` on `QuoteLineRequest`, and the fix is the same:
  where a caller must not be allowed to omit something, the type says so.
- **A transaction is not a lock.** Postgres' default READ COMMITTED lets two
  transactions count the same rows and both insert, because neither has written
  anything the other conflicts on. A quota needs `pg_advisory_xact_lock` (or a
  constraint), and "we wrapped it in a transaction" is not the same claim.
- **Two writers means two places to stamp.** `trialUsedAt` and the reconcile
  queue both have to be set by `syncSubscription` _and_ the
  `app_subscriptions/update` handler. Any fact derived from a plan change needs
  checking against both, every time.

- **A comment that states a property is not the property.** `money.ts` has said
  "no price arithmetic here touches a floating-point value" since 1.1, three
  feet above a float multiply. Same shape as the discount Function's "anything
  unexpected costs one line, not the cart" sitting above a `try` outside the
  loop, and `snapshotFrom`'s "keep them working and make the mismatch loud"
  above a `return FREE_SNAPSHOT`. When a comment states a guarantee, grep for
  the code that would have to enforce it.
- **A model without a writer is a feature that does not exist.** `MarketScope`
  and `CurrencyAmount.overrides` were both in the engine from 1.1, both
  exercised by golden vectors, and neither reachable: every production writer
  emitted the empty default. The vectors passed the whole time. If a field has
  no form, no importer and no AI path that can set it, it is a plan, not a
  feature — and a golden vector over it tests the engine, not the product.
- **Day-granularity dates are a timezone question.** `new Date("2026-07-01")` is
  UTC midnight, so "ends 1 July" killed a rule for the whole of the day it
  named, and "starts 1 July" went live at 18:00 on 30 June in California. The
  shop's `ianaTimezone` was right there and used only by analytics.

- **A gate stops a request; a metafield has no request to stop.** Every
  capability this app delivers through a published metafield — the ruleset, the
  order limits, the buyer's terms, the product's collections — is evaluated by
  Shopify without calling us. `assertFeature` in front of the editor changes
  nothing about what is already published, so any plan, pause or entitlement
  change has to **republish**. Three of the five billing P0s were one shape of
  this, and the `pausedAt` fix in 6.4 was a fourth.
- **An empty answer is not a negative answer.** `billing.check` filters by plan
  name and by test mode, so "no subscriptions" also means config drift. Writing
  the safe-looking default on it cut off paying merchants. Ask what else could
  produce the empty result before treating it as the fact you wanted.
- **A fixture with a `planKey` and no `billingStatus` is a Free shop.** The
  entitlements logic reads both, and a row with a plan and no status never
  subscribed. Production always writes them together; test fixtures did not, and
  one of them started failing the moment the quota became load-bearing.

- **A metafield is the only thing checkout knows, and a webhook only fires on
  change.** Every fact the discount Function needs — the ruleset, the buyer's
  tags, the product's collections — reaches it through a metafield this app
  writes, because the Function's input query is fixed at deploy time. So each
  of those needs _both_ a webhook (for changes from now on) and a backfill (for
  everything that already exists). Customers and orders had one; products did
  not, for the whole of milestones 1 to 7. If you add a fourth such fact, the
  backfill is part of the feature, not a follow-up.
- **`collectionIds: []` in a shared pricing function is four different prices.**
  The engine is pure and correct; it answers the context it is given. The bug
  was never in `packages/pricing-engine` — it was that four callers handed it an
  _incomplete_ context, so "one module, one answer" still produced four. Where
  a caller cannot omit a field, make the type require it: making
  `QuoteLineRequest.collectionIds` required found all eight call sites in one
  `tsc` run, including two nobody had thought about.
- **Read the same source as the thing you must agree with.** The storefront
  could have asked Shopify for a product's collections directly and been
  _fresher_ than checkout — and therefore wrong, because checkout reads the
  metafield. Agreement beats freshness whenever a buyer is shown a number they
  will later be charged.
- **Shopify serialises `MoneyV2.amount` with a decimal point in every currency.**
  A ¥1,000 line arrives as `"1000.0"`. Any parser that treats "digits past the
  exponent" as "too much precision" refuses it. Trailing zeros are formatting;
  only a _significant_ digit past the exponent is a rounding decision. Two
  Functions had a money bug of this shape, in opposite directions.
- **Never hardcode `× 100`.** `mannon-limits` did, so a ¥1,000 cart read as
  ¥100,000 and cleared every minimum. `parseMoney` knows the exponent table;
  there is no second place that should.
- **A `try` around a whole loop is not a per-item guard.** The discount
  Function's header promised "anything unexpected costs one line, not the
  cart" and the code did the opposite, because the only `catch` was outside the
  loop. Where a comment states a blast radius, check the brace it sits in.

- **`Order.totalPrice` is ALREADY net of refunds.** It comes from Shopify's
  `current_total_price`. Never subtract `refundedAmount` from it —
  `app/lib/orders/totals.ts` is the one definition, and the bug was in seven
  places at once before 6.2's cold read found it.
- **Three tests in a row have "passed" by encoding the bug they guarded** —
  two in 6.2, one in 3.2's terms suite. All three hand-set a column combination
  the production writer cannot produce. Before trusting a test that guards a
  money rule, ask what the _writer_ stores, not what the fixture can.
- **Postgres does not survive a container recycle.** `service postgresql start`,
  then `pg_isready`. The symptom is every vitest run failing in global setup.
- **Charts are server-rendered inline SVG, no library.** Geometry lives in
  `app/lib/analytics/geometry.ts` so it is testable; the palette in
  `app/components/analytics/palette.ts` was chosen with the `dataviz` skill's
  validator against `#ffffff` and `#1a1a1a`, not by eye. Re-run it before
  changing a hex. **Look at the rendered PNG** — the label-overflow bug in 6.2
  was invisible to every test and obvious in the screenshot.
- **A "validated" GraphQL query is not a query that runs.** 6.1's shipped with
  `lineItems(first: 100)` nested inside `orders(first: 100)` — schema-valid,
  and about a hundred times over Shopify's 1,000-point _calculated cost_
  ceiling, so every page of the backfill would have been rejected. Cost is
  roughly the product of the `first` values. Check it whenever a connection
  goes inside another one.
- **Shopify's `quantity` and line totals are _before_ returns.** `Order` is
  written from the `current_*` fields, so anything read off a line has to use
  `currentQuantity` / `currentTotal` or it will disagree with the order it
  belongs to. Charts read `currentTotal`.
- **Five cold reads in a row have returned FAIL** (4.4, 4.5, 5.1, 5.3, 6.1), every
  one of them after my own seven-step gate passed. The gate is not the problem;
  what the gate cannot do is disbelieve the fixture it was handed. 5.3's worst
  finding — a merchant's reply going nowhere — was invisible to every test I
  wrote because I only ever tested the two halves that existed. **Ask "who reads
  this row, and how does it get to them?" for every write.**
- **A state capture built by flipping a flag on the happy-path fixture proves
  nothing.** 5.3's taken-over capture did that, so the announcement row and the
  merchant's own turn had never been rendered at all — and the announcement,
  stored with empty text, read as "the agent couldn't answer". Build a capture
  from the rows the production writer actually writes.
- **`CATALOG_ROOTS` is now derived from `en.json`** rather than hand-listed. It
  had silently stopped guarding a whole page family twice (4.2, 5.3).
- **`.env` wins over a shell `DATABASE_URL`.** Pointing a vitest run at a
  scratch database from the command line does not work — the setup loads `.env`
  last. Two concurrent `npm test` runs still corrupt each other.
- **The storefront blocks have a 16KB budget each** (`tests/unit/storefront-blocks.test.ts`).
  The Buyer Agent widget is at 16.3KB of it. Comments in a shipped block reach
  the wire: the reasoning belongs in `docs/adr/0023`, not in the Liquid.
- **`Order` had no line items until 6.1.** `OrderLine` now mirrors them with
  their discount allocations. Rule performance is read from the **discount
  title** — the Function sets the winning rule's name as the message — so a
  renamed rule keeps its history under the old name. `docs/adr/0024`.
- **7.2's GDPR redaction has one more table to reach**: `OrderLine` hangs off
  `Order` and is covered by the cascade, but check it when writing that handler.

- **Read `CLAUDE.md` first, then this file.** The specs are checked in at
  `docs/spec/`; the architecture reasoning is in `docs/adr/` (thirteen so far).
- **Postgres is not always running.** `service postgresql start`, then
  `pg_isready`. Two databases: `mannon_dev` and `mannon_test`.
- **Run `npm run build` before `npx playwright test`** — the e2e server serves
  `build/`, and a stale build tests yesterday's code.
- **`npm run qa:capture`** renders every state to `qa/<task>/` and screenshots
  it. Adding a task means adding its state test to that script and a
  `captureSuite("<task>")` line in `tests/e2e/qa-states.spec.ts`.
- **The capture harness checks for raw i18n keys** on every capture. If a new
  catalog root appears, add it to `CATALOG_ROOTS` in
  `tests/support/state-capture.tsx`. (4.2 added `describe` — the guard was
  silently not covering the new page until then.)
- **A write and its audit entry belong in one transaction.** 4.2 found
  `createRule` doing them as two awaits: a refused AI-assisted entry — the very
  thing the invariant produces — left a live pricing rule nobody was recorded as
  approving. `recordAudit(entry, tx)` takes the transaction client. `updateRule`
  and `archiveRule` still have the two-await shape; no AI path reaches them, but
  it is the same latent gap.
- **Claude is never given an id and never returns one.** 4.2's draft flow hands
  the model collection titles and group names and resolves them against this
  shop's own catalogue. That is also what closes the tenant hole: resolution can
  only ever emit an id it was given, so a forged payload reads as an unanswered
  question rather than a leak. Reuse the pattern for every later feature that
  names a merchant's objects.
- **Every GraphQL operation in this app is now schema-validated.** 4.4 ran all
  29 through Shopify's own validator (the AI Toolkit's MCP server, which works
  here even though `shopify.dev` does not). All valid. Two deprecations found
  and fixed: `Customer.email` → `defaultEmailAddress.emailAddress` and
  `Customer.phone` → `defaultPhoneNumber.phoneNumber`. Re-validate after
  writing a new query — it is the only check on them that is not a guess.
- **A test fixture typed `as never` is a fixture the compiler never checks.**
  The customer node fixture was untyped, so the deprecated-field migration
  above changed every synced buyer's email to null and _no test failed_. It is
  now `CustomerNode` and asserts the email and phone it produces.
- **A Remix action's `json({ view })` is NOT what the component renders.** A
  non-redirect action response re-runs the loader, so a component reading only
  `useLoaderData` throws away everything the action computed. Five routes had
  this (shipped in 1.3, copied in 4.2): validation errors never appeared, the
  CSV dry run never rendered, and 4.2's ✦ draft could not appear at all. Every
  route whose action returns a view now does
  `const { view } = useActionData() ?? useLoaderData()`. Check this on every new
  route that answers a POST with a view.
- **A Polaris `s-button` has no `name` or `value`** (checked against
  `@shopify/polaris-types`), so one form is one intent. Two submits in a form
  silently post the first one. Use a link the loader handles, or a second form.
- **The honeypot owns the field key `website`** (`app/lib/forms/spam.ts`), which
  is why it is in `RESERVED_KEYS`. A form keyed that way drops every real
  applicant as spam. ✦ Screening therefore scans every answer for a URL rather
  than reading one field.
- **`vitest` does not typecheck.** 4.2 shipped a fixture that silently dropped
  its overrides (twenty assertions passing vacuously) and a helper typed as the
  wrong interface; `npm run typecheck` caught the second, the first only showed
  up because the assertions started failing. Run both.
- **Never `vi.spyOn` a Prisma delegate method.** A delegate resolves its
  methods through a proxy, so `mockRestore()` leaves the method `undefined` and
  silently breaks every later test in the file (4.1 lost three that way).
  Inject a seam instead — the repo's idiom, as with `AdminForShop`.
- **The AI wrapper takes an `AiDeps` bag** (`messages`, `record`) purely as a
  test seam; nothing in the app passes it. That is how the timeout, the retry
  rule and every failure path are driven with no key.
- **Hardcoding a currency's ×100 is the recurring money bug.** It has now been
  written three times (3.2 shipped it, 3.3 avoided it, 3.4 caught it again in
  the SKU path). Always `parseMoney` for a decimal string, and prefer a source
  that is already in minor units — Liquid's `variant.price` is.
- **The four recurring bug shapes**, all now guarded: English plural keys
  written without `_one` (caught three times), boolean props on `s-*` elements
  (twice), a pluralised key called without `count`, and — new in 3.1 — a
  machine-readable code that ends in a plural suffix (`increment_below_two`),
  which i18next reads as Arabic `_two`.
- **Run the `qa-engineer` cold read on every task.** 4.4, 4.5 and 5.1 all passed
  the author's own seven-step gate and all three came back FAIL. 4.5's headline
  feature did not work for three ordinary inputs; 5.1's price guard — the one
  rule the spec states twice — was blind in five shapes and refused the two
  flows the spec leads with. The gate finds what the author thought to check.
- **A guard that pattern-matches free text is the wrong shape.** The Buyer
  Agent's first price check scanned replies for money. `\d` is ASCII-only in
  JavaScript even under `/u`, so Arabic was invisible to it. The fix was not a
  better pattern: the model now writes `{{f1}}` and this app substitutes. When
  a check has to be right in every locale, do not let the model produce the
  thing being checked.
- **A test fixture that sets a column the production writer never sets is a
  test that cannot fail.** 4.5's KPI fixture hand-set `Order.createdAt`, which
  `rowData()` leaves to its default — so a query reading the wrong column
  passed. When a fixture sets a field, check that the real writer does too.
- **The setup wizard is the widest write path in the app** — one model answer
  becomes groups, a live rule and a form. It is safe only because it goes
  through `createGroup`/`createRule`/`createForm`, the same functions the manual
  path uses. Never give it a shortcut; `docs/adr/0022` says why.
- **A view-model that lives in a route cannot be tested here.** Driving a Remix
  loader needs a Shopify session this environment cannot mint, so anything worth
  asserting belongs in a module the route imports: `app/lib/agent/home-view.server.ts`
  and `app/lib/orders/po-envelope.server.ts` were both pulled out of their routes
  in 4.4's fix round for exactly this, and both immediately found bugs. The route
  keeps the wiring; the decisions move out.
- **Theme blocks are driven in a browser** by `tests/e2e/storefront-blocks.spec.ts`
  through `tests/support/liquid-stand-in.ts`. Adding a Liquid construct a block
  uses may need adding to the stand-in — it renders unknown tags as nothing, so
  a gap shows up as missing markup in a capture.
- **Two `npm test` runs at once corrupt each other.** They share one
  `mannon_test` database and each `resetDatabase()` truncates it, so a
  concurrent run fails in unrelated files and looks like a real regression.
  4.4 hit this while a QA subagent ran the suite in parallel. Re-run a single
  file to tell contention from a genuine break.
- **`npm test` needs Postgres running**, and it stops between sessions:
  `service postgresql start`, then `pg_isready`. The failure looks like "No test
  files found", not like a database error.
- **Adding an optional field to a published payload is a silent-removal bug.**
  3.2 added `terms` to the buyer metafield; five existing callers would have
  published `null` and withdrawn a merchant's credit without a trace. Making
  the field _required_ turned it into a compile error that found all five. Do
  the same for anything else that reaches checkout.
- **`NOT: { a, b, c }` in Prisma is a trap when any column is nullable.** SQL
  three-valued logic makes the whole `NOT` unknown, and the row matches neither
  branch. 3.1 lost every order without net terms from page 2 this way; the fix
  is to spell the complement out as an `OR`.
- **A fake admin in an integration test needs the discount-Function query.**
  Anything that calls `createRule` publishes a ruleset, which resolves the
  Function id first. Answer `MannonDiscountFunction` or the test fails with a
  confusing "run `shopify app deploy`".
- **The webhook registry test is a real gate.** Adding a topic to
  `WEBHOOK_SUBSCRIPTIONS` without adding it to `shopify.app.toml` fails the
  build, and the test also asserts a topic nothing handles — pick one Mannon
  genuinely does not subscribe to.
- **Prisma promises are lazy.** They must be settled inside the ALS scope —
  `settleInScope` in `app/lib/tenant/shop-context.server.ts` exists because of a
  bug where the tenant was lost between building a query and awaiting it.
- **A migration edited after it was applied** breaks `prisma migrate dev` with a
  checksum error. Fix by updating the recorded checksum, not by resetting.
- **GitHub is reachable** even though shopify.dev is not — `Shopify/function-examples`
  was cloned for the authoritative Function schema rather than working from memory.

- **A capture is read as a picture; its assertions are not.** Two captures in
  one set that render identically mean one of them does not show the state its
  name claims — and every test still passes, because each asserts against the
  one page they share. This had happened six times across five milestones
  before anybody looked at the PNGs side by side. `expectDistinct` in
  `tests/support/state-capture.tsx` now fails it, naming both files. **Do not
  switch it off to get a set to build.**
- **The capture stand-in only shows what it has a CSS rule for.** Field errors
  were invisible in every capture for nine tasks because nothing styled
  `[error]`, so a screenshot taken to prove "errors are red, inline, beside the
  field" proved nothing. Before trusting a capture of an attribute-driven
  state, check `STYLES` renders that attribute.
- `qa:capture` globs `tests/unit/*-states.test.tsx` now rather than listing the
  files. A hand-kept list is a registration step to forget — this is the third
  one found (after `CATALOG_ROOTS`).

- **A fixture written from the catalogue is not a fixture from the producer.**
  6.3's ask captures used `chart: "byGroup"` — the i18n key, not the `ChartKey`
  the route emits — so the raw-key guard was fed a value guaranteed to resolve
  and never saw that three of seven charts printed `analytics.groups.heading`
  at the merchant. The view type said `string`. Typing it as the union made the
  compiler reject both fixtures immediately. **When a view field can only hold
  a few values, type it as those values**; `string` is where this class hides.
- **The refund double-subtraction has now been found three times** (6.1, 6.2,
  6.3) and twice by a cold read. `app/lib/orders/totals.ts` is the only
  definition — but an aggregate cannot call a per-row function, so restating
  the rule for a `_sum` is the shape it comes back in. That is what
  `orderRevenueOfSum` is for. **Any new money query: if you are writing
  `totalPrice` and `refundedAmount` in the same expression, stop.**
- **`monthStart` was a one-directional walk.** Anything that walks from a guess
  towards an answer has to be able to walk both ways, or it is only correct on
  the side it was tested. The four zones in its test topped out at UTC+11; the
  bug started at UTC+12. It is a binary search now, on a fifteen-minute grid
  because Kathmandu and Chatham are not on the hour.

- **The capture stand-in only shows what it has a CSS rule for.** Three times
  now: `[error]` (invisible for nine tasks), then `details` and `checked`
  (invisible in _every_ capture ever taken, until 6.4 — which made a settings
  page's help text and every tick mark unreadable). Before trusting a capture
  of an attribute-driven state, check `STYLES` in
  `tests/support/state-capture.tsx` renders that attribute. Assertions passing
  on an attribute prove nothing about whether a reader can see it.
- **A flag is not a feature.** `pausedAt` existed from 0.1, was read in one
  place, and "pause the app" left the discount Function pricing every
  checkout. When a column implies behaviour, grep every read of it before
  believing the behaviour exists — `docs/adr/0026`.
- **Careful with backticks and `\\` inside the `STYLES` template literal.**
  A backtick in a CSS comment ends the literal; `\A` is a JS escape, so CSS
  needs `\\A`; and `\26A0` is a legacy octal escape that esbuild refuses —
  use the glyph. All three cost a round trip this session.

- **A `<form>` inside a `<form>` is not a form.** The parser drops the inner
  start tag and its inputs join the outer one, so the Notifications section's
  Save posted `intent=verify` and returned 501 — unsaveable in a browser while
  fifteen assertions on the HTML _string_ passed. A string can hold markup no
  browser will build. `tests/e2e/settings-forms.spec.ts` now parses the real
  captures in Chromium and asserts what each section posts; add a case to it
  whenever a page grows a form.
- **A setting with no reader is a lie with a checkbox.** Five of 6.4's nine
  columns were write-only while the copy beside each promised specific
  behaviour. Before shipping a control, grep for a consumer of the column
  outside the page that writes it. One of the five had no behaviour to gate at
  all and was deleted — a toggle for a feature the product does not have is
  worse than no toggle.
- **Two-step remote operations need the dangerous direction picked
  deliberately.** Pause writes the flag then publishes; resume publishes then
  clears, and restores the flag if the publish fails. `pausePublishedAt` exists
  because a derived signal could not tell "the pause landed" from "this shop
  has never published".

- **`allowed` in a view is not a gate.** 6.5 converted fifteen call sites to
  `aiGate` and four of them assigned the result into a view that disables a
  button, while the POST handler behind it called Claude anyway. The rule was
  already written in this repo — `app.storefront-agent.test.tsx`: _a disabled
  button is a courtesy, not enforcement_ — and the suite was green because
  **not one test posted to a ✦ action with the permission off.** `requireAi()`
  throws; every ✦ action calls it before it reaches a prompt. When adding a ✦
  surface, the test to write first is the POST with the thing switched off.
- **A spec contradiction has to be written down, not resolved quietly.**
  §8 wants twelve months of audit; Invariant 3 wants an AI approval recorded
  forever. 6.5 deleted the approvals. CLAUDE.md stop condition 6 asks for both
  lines quoted and one picked — see `DECISIONS.md`. Invariant 3 won.
- **A new table is not reached by the uninstall purge unless it is named.**
  `BrandVoiceSample` holds the merchant's real emails to buyers and had no
  relation, so no cascade touched it, under copy promising deletion in 48
  hours. `purge-shop-pii.server.ts` now names it. **7.2 must check every table
  against that file**, not just the two already listed.
- **An i18next override is only real where the instance is built.** A flat
  `{"forms.submit": …}` bundle does not work: i18next reads a dot as a path, so
  it creates a literal dotted key that nothing ever looks up. `createI18n` adds
  each override with `addResource(locale, ns, key, value)`, which is also the
  only place an instance is made — so no surface can translate without a
  merchant's wording. The test that matters is not "the row saved" but "the
  buyer reads it": `getFixedT` before and after.
- **The capture guard now has one per-element exemption, and it is tested.**
  Settings → Translations shows catalog keys on purpose, so an element may opt
  out with `data-string-key`. Per element, never per page — that page is
  exactly where a genuine i18next fallback would be hardest to spot.
  `tests/unit/capture-guard.test.ts` puts a real leak beside an exempt element
  and expects a failure.
- **An `s-*` field is not a form control in a capture.** `s-text-area
name="value"` never reaches `FormData` in the browser here, because Polaris
  never upgrades it. The e2e form-parser checks (the 6.4 nested-form net) can
  see hidden inputs and form _count_, and cannot see what a merchant's typing
  posts. Assert `s-*` fields as markup and say so in the report.
- **The fourth inert control was caught before shipping, not after.** "✦ Fill
  missing translations" would have had nothing to do on any store, because both
  catalogues ship complete. Whenever a ✦ button acts on "what is missing",
  compute the count on a fresh install first: if it is zero, the button is
  decoration. The three before it were `taxExemptNeedsApproval`, the
  auto-approve toggle and the API keys page.
- **A closed list given to a model is a registration step too.** The ✦ ask
  router validated the chart name against `CHART_KEYS` while the _menu_ the
  model chose from was typed out inside the prompt template. Adding a chart
  passed every test and could never be routed to. Both now come from one
  exhaustive `Record<ChartKey, string>`, checked by
  `tests/unit/analytics-ai.test.ts`. When a prompt lists anything the app also
  enumerates, generate it — and bump `PROMPT_VERSIONS`.
- **A count is not money, and a chart borrows more than you think.** The orders
  chart had to be kept away from four things the revenue chart beside it does:
  currency formatting, a 1/2/5 axis (`niceMax` makes three orders a scale of
  five, labelled 3.75), a trend line between whole numbers, and a "Currency"
  column in the CSV. `wholeMax` exists for the axis half of that.
- **`addResource` writes into the object you handed i18next.** `resources` holds
  a direct reference to the imported `en.json`, so one shop's override rewrote
  the shipped catalogue for the whole Node process and served that shop's
  wording to every other shop's buyers. A shop's wording is its own namespace
  now (`OVERRIDE_NAMESPACE`), built fresh per instance with `fallbackNS` to
  `common`. **A tenancy test has to render between the write and the read** —
  mine saved in Alpha and read in Beta with nothing in between, which is the
  shape of the test and not the shape of production.
- **"There is exactly one place X happens" is a `grep`, not an ADR sentence.**
  ADR 0028 claimed one i18next creation site; there were three, and two of them
  served buyers.
- **Three P2s from the 6.6 cold read are deliberately unfixed**, all recorded
  here rather than in a round that was already large: no length cap on a single
  saved string (the import file is capped at 2 MB); `buildView` calls
  `unwrittenIn` on every page load just for its `.length`; and a save is
  last-write-wins between two staff on one key.
- **A prompt version is not a feature.** `reorder_prediction` and `terms_risk`
  sat in `AI_FEATURES` and `PROMPT_VERSIONS` from 4.1 to 6.7 with no prompt, no
  caller and nothing on any screen, next to a `dueToReorder: false` hardcoded in
  a view model. Both turned out to be arithmetic. When adding a name to a
  registry, add the thing it names in the same commit or don't add the name.
- **A fixture is a row, and a row's fields agree with each other.** Three
  captures in 6.7 said two contradictory things at once — "overdue" beside "due
  in 12 days", "10 days ago" beside "it has been 24" — each a row the loader
  cannot build. The earlier lesson was about values the writer never writes;
  this is the same lesson inside one row.
- **The theme block budget counts what a buyer downloads.** It used to count
  the file on disk, including `{% comment %}` and `{% schema %}`, which Shopify
  strips — so it was 99.2% spent and pushing against documenting storefront
  code. JS comments are still counted: those really are shipped, so keep them
  terse in a block and put the reasoning in the Liquid header comment, which is
  free.
- **Two rows written in one turn need a tiebreaker.** `appendTurn` stamps the
  buyer's message and the agent's with one `now` on purpose, and every read
  ordered by `createdAt` — so the transcript's order was whatever Postgres felt
  like, and a merchant could read the reply above the question.
  `AgentMessage.seq` is the total order now. Anywhere two rows can share a
  timestamp, ordering by that timestamp is not an ordering.
- **A Shopify customer id is the same value in every shop that person bought
  from.** So one merchant's deletion request must never reach another's record
  of the same human being. Three tests in `tests/integration/privacy.test.ts`
  seed the same buyer in two shops and check exactly that.
- **Uploaded files are rows** (`FormUpload.content` is `Bytes`), so deleting the
  row is the whole deletion. If they ever move to object storage, every
  deletion path in `app/lib/privacy/` and the shop purge needs a second half.
- **Shopify's privacy topics are `compliance_topics`, never `topics`.**
  `@shopify/shopify-api`'s `register.ts` skips every topic in its
  `privacyTopics` list, so they reach an app only through the app config's
  compliance key. Declared as `topics` they register with nobody and the
  handlers never run — and `compliance_topics` ends in `topics`, so the drift
  test's regex matched both and stayed green. It tells them apart now.
- **A guard built from a list of field names cannot be complete**, because the
  next table's columns have not been named yet. The privacy coverage guard
  classified 9 of 32 models as personal and missed the buyer's uploaded trade
  licence (`fieldKey`, `fileName`, `contentType`, `byteSize`, `content` — not a
  personal-sounding word among them). It is a **total map** now: every model
  has a written disposition and a new one fails the build. Rewriting it that
  way immediately found `AiRun`, which nothing had ever deleted.
- **A handler must not write the flag its own safety check reads.**
  `shop/redact` stamped `uninstalledAt` — the purge's only guard against
  deleting a live shop — and then queued the purge for _now_. The test I wrote
  asserted the stamp was written and never ran the job, so it proved the first
  half of the bug and called it the feature.
- **`piiPurgedAt` is cleared on reinstall.** It was not, and the purge skips any
  shop that has one: install → uninstall → purge → reinstall → trade a year →
  uninstall deleted nothing, for ever, under copy promising 48 hours.
- **An empty secret is worse than a missing one.** `SHOPIFY_API_SECRET ?? ""`
  does not make verification fail; it makes it succeed against an empty key.
  Anywhere a credential has a `?? ""` behind it, the question is not "does it
  still work" but "what does it now accept".
- **The job runner is an external cron, and a cron that never ran looks like a
  quiet app.** `/healthz/ready` names `runnerStalled` because nothing else in
  the product ever would — and everything this app promises on a schedule
  (the 48-hour GDPR purge above all) depends on it.
- **`shopify.dev` is unreachable from here, and the App Store self-review
  cannot be run.** `shopify doc fetch` returns 403 through the agent proxy, as
  does a direct request. The skill that performs that review says never to work
  from a remembered list, so 7.3 did not produce one. `npm run release:check`
  is the local subset instead, and it is careful to say what it is not.
- **Every URL in `shopify.app.toml` is still localhost, and the fix is one
  variable.** `SHOPIFY_APP_URL=https://<host> npm run config:urls` writes all
  five; `npm run deploy` runs it first. What is outstanding is not the edit but
  **the hostname** — nobody has said where this app is deployed, and an invented
  one would be worse than localhost, which at least announces itself.
  `npm run release:check` exits non-zero while any of the five names a
  development host and now names each key. It is deliberately **not** part of
  `npm test`: the blocker is real and outstanding, and a red suite everybody
  learns to ignore is worse than no check.
- **A test that builds the object under test by hand tests half the system.**
  The golden vectors constructed `PricingRule`s in the test file, so all 41
  passed against a codec that dropped `excludeCollectionIds` — the field whose
  absence charged excluded products the wholesale price. They go through
  `serializeRule` → JSON → `deserializeRule` now, which is the trip the
  checkout Function actually makes.
- **A vector whose name states a property does not test it.** "Rounding happens
  once at the end, not per rule" listed _one_ rule, and with one rule the two
  behaviours are the same arithmetic. Same shape of miss as "a comment that
  states a property is not the property", one layer out: the name was the claim
  and nobody read the `rules` array under it.
- **A catalogue key is not evidence that a feature exists.** The orphan map
  found 37 unrendered keys, and most were not dead weight — they were copy
  written for a control nobody built: the rule builder has no way to add a
  tier and no unsaved-changes guard, the CSV page has no dropzone, the error
  boundary does not read the catalogue. Deleting the words would have hidden
  four real gaps. They are listed in `WRITTEN_AHEAD` with what is missing, and
  the test fails the day one of them is built.
- **A flag with no per-tenant answer is wrong for somebody either way.**
  `SHOPIFY_BILLING_TEST_MODE` is process-wide, and the README asked an operator
  to set it per store. When a question is really per-tenant, ask the tenant:
  Shopify knew which stores were development stores all along.
- **A deferral with no failing test is a decision to never do it.** "No
  relations exist yet; assert the shape that keeps this honest as the schema
  grows" was correct when written and wrong four tasks later, and nothing
  anywhere went red. A note that says "come back when X" belongs in a test that
  fails when X happens — which is what the two DMMF-driven completeness tests
  in `tenant-relations.test.ts` now are.
- **Know which layer holds a guarantee.** The extension does not stamp a nested
  create inside an `update`; the composite `(shop, parentId)` foreign keys do.
  Four documents said the extension covered everything, so a reader adding a
  table would not have thought to add the foreign key.
- **An applied migration is not editable, not even to add a comment.**
  `migrate deploy` checks each file against the checksum in
  `_prisma_migrations`, so a tidying edit fails the deploy everywhere it has
  already run. Anything a future reader needs to know about one goes in
  `prisma/migrations/README.md`.
- **"All fixed" in a PROGRESS line is a claim, not a check.** Twenty-seven P3s
  were recorded as fixed at their own task; four were not. Re-deriving them
  from the source cost an hour and found a pause flag that could be set with
  no record of who set it.
- **The severity ladder ends at P3.** Four cold reads number their bands
  (6.2–6.5) and stop there; 5.3 numbers its _findings_ `P1`–`P17` with the
  severity as a word beside each, and 6.1 numbers findings `F1`–`F11` and
  _probes_ `P1`–`P9`. So "P4" matches a finding, a probe and nothing else. When
  a request names a band, check the taxonomy before assuming there is work.
- **A guarantee that lives in a comment is a guarantee the next reader will
  not have.** `OrderLine`'s header stated the currency join requirement and the
  cold read filed the finding anyway. The column costs a migration and cannot
  be forgotten; the sentence cost nothing and already had been.
- **A value that has to be typed in five places will be wrong in at least
  one.** The app's origin lived in five strings in `shopify.app.toml` and in
  `SHOPIFY_APP_URL`, which the app already required to boot. The fix was not
  editing five strings; it was making one command write all five from the
  variable that already existed. Look for this shape anywhere a config file and
  an environment variable state the same fact.

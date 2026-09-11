# Progress

Updated: 2026-09-11T18:30:00Z
Current milestone: 6 — Analytics
Current task: 7.2 privacy [done] · 7.1 / 7.3 release [next]

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

- [x] 6.6 Translations — every buyer-facing string editable per language, ✦ wording suggested in the merchant's own voice, a review flag per string, export **and** import — commit `2ecabba` — QA: `qa/6.6/REPORT.md` (`docs/adr/0028`). The ✦ half nearly shipped inert for the fourth time: both catalogues ship complete, so "fill what is missing" would have had nothing to do on any store. It suggests wording over the strings a merchant has **not** written instead, which is also the first thing to read the 6.5 brand-voice samples. `StorefrontString` was not in the uninstall purge — the lesson from 6.4, applied before the cold read this time. **The cold read still returned FAIL on four P0s** (`qa/6.6/COLD-READ.md`), the worst a cross-tenant leak *outbound to buyers*: `addResource` writes into the object it is handed, so one shop's saved string rewrote the shipped catalogue for the whole process. Fixed in `aac76e3`: overrides are their own i18next namespace; the editable set is now ~50 genuinely buyer-facing keys rather than 534 mostly-admin ones; the checkout message is editable for real; an ✦ suggestion no longer reaches a buyer before a person accepts it; the page is one form with a save bar.

- [x] 6.7 (part) Orders over time — an eighth chart, counts not money, with its own whole-number axis — commit `7dcd13e` — QA: `qa/6.7/REPORT.md`. Closes the `pages-features.md` §7 line deferred at 6.2. The ✦ chart menu was a hand-kept list **inside the prompt**: adding a chart to `CHART_KEYS` satisfied the validator while the model was never told it existed, so nothing could route to it. Generated from an exhaustive record now, with a test.

- [x] 6.7 (part two) The three things that were registered and never built — the reorder chip (hardcoded `false` since 2.1), the net-terms risk signal (`terms_risk`: a prompt version, no prompt, no caller, no screen) and the widget greeting's tier and last order (open since 5.2) — commit `e9b2703` — QA: `qa/6.7/REPORT.md`. **Neither chip needed a model**: both are arithmetic on rows this app already stores, so `reorder_prediction` and `terms_risk` are deleted from the AI registry rather than left as names for features that do not exist. Found on the way: the Buyer Agent block was at **99.2% of its byte budget** because the guard counted `{% comment %}` and `{% schema %}`, neither of which Shopify ever serves — so the budget was pushing against documenting storefront code.

- [x] 7.2 (part) Privacy — Shopify's three mandatory topics (`customers/data_request`, `customers/redact`, `shop/redact`), which this app subscribed to **none** of, and a shop purge that finally reaches the buyers — commit `89de3d3` — QA: `qa/7.2/REPORT.md`. The purge cleared the *merchant's* two contact fields and left every buyer's name, address, phone, VAT number, form answers, uploaded documents and every message sent to them behind, under copy promising deletion within 48 hours. **The cold read returned FAIL on three P0s and seven P1s** (`qa/7.2/COLD-READ.md`) — fixed in `390523c`. The worst: `shop/redact` wrote the very `uninstalledAt` the purge checks before deleting, so one delivery for a shop whose uninstall we had missed wiped a **live, trading merchant**; a reinstall never cleared `piiPurgedAt`, so a shop that had ever been purged could never be purged again; and the three topics were declared as `topics` rather than `compliance_topics`, which means Shopify is never told where to send them and the whole feature ships inert. Plus the retention sweep for the five tables that only ever grew.

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
  `[app_proxy]` url in `shopify.app.toml` still points at localhost and needs
  the real app URL at deploy time.
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
  see hidden inputs and form *count*, and cannot see what a merchant's typing
  posts. Assert `s-*` fields as markup and say so in the report.
- **The fourth inert control was caught before shipping, not after.** "✦ Fill
  missing translations" would have had nothing to do on any store, because both
  catalogues ship complete. Whenever a ✦ button acts on "what is missing",
  compute the count on a fresh install first: if it is zero, the button is
  decoration. The three before it were `taxExemptNeedsApproval`, the
  auto-approve toggle and the API keys page.
- **A closed list given to a model is a registration step too.** The ✦ ask
  router validated the chart name against `CHART_KEYS` while the *menu* the
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
  deleting a live shop — and then queued the purge for *now*. The test I wrote
  asserted the stamp was written and never ran the job, so it proved the first
  half of the bug and called it the feature.
- **`piiPurgedAt` is cleared on reinstall.** It was not, and the purge skips any
  shop that has one: install → uninstall → purge → reinstall → trade a year →
  uninstall deleted nothing, for ever, under copy promising 48 hours.

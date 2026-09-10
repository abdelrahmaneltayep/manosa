# Progress

Updated: 2026-09-10T17:20:00Z
Current milestone: 4 — Claude
Current task: 5.1 Storefront Buyer Agent [starting]

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
- [x] 4.5 Home assembled: KPI cards, setup checklist, activity log, ✦ Setup Wizard — commit `ef73ee3` — QA: `qa/4.5/REPORT.md`

## Next up

- 5.1–5.3 Storefront Buyer Agent · 6.1–6.3 Analytics, Settings, polish · 7.1–7.3 Release

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

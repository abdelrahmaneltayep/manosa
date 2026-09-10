# Progress

Updated: 2026-09-10T10:25:00Z
Current milestone: 3 — Orders
Current task: 3.2 Net terms: eligibility, pay-later, ledger with aging, reminders [in progress]

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

## Next up

- 3.2 Net terms: eligibility, pay-later via draft orders, ledger with aging, reminders
- 3.3 Quotes and draft orders: request pipeline, expiry, accept link, price locking
- 3.4 Quick order storefront blocks, inside the ≤10-point Lighthouse budget
- 4.1 AI infrastructure: client, streaming, timeouts, audit hooks
- 4.2 Rule-from-a-sentence, margin guard
- 4.3 Registration screening, drafted emails, segments, CSV whisperer
- 4.4 Merchant Agent briefing, Ask Mannon bar, PO-to-order
- 4.5 Home page assembled, Setup Wizard
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
- **`ANTHROPIC_API_KEY` is not set.** Needed from 4.1. Everything AI is built to
  degrade to the manual path without it, so this blocks verification, not work.

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
- **Editable limit messages** → 6.2, Settings → Limit display. `DEFAULT_MESSAGES`
  ships English only and already carries the gap number.
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
  `tests/support/state-capture.tsx`.
- **The four recurring bug shapes**, all now guarded: English plural keys
  written without `_one` (caught three times), boolean props on `s-*` elements
  (twice), a pluralised key called without `count`, and — new in 3.1 — a
  machine-readable code that ends in a plural suffix (`increment_below_two`),
  which i18next reads as Arabic `_two`.
- **`NOT: { a, b, c }` in Prisma is a trap when any column is nullable.** SQL
  three-valued logic makes the whole `NOT` unknown, and the row matches neither
  branch. 3.1 lost every order without net terms from page 2 this way; the fix
  is to spell the complement out as an `OR`.
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

# Mannon — build progress

Phase gates: a phase is not started until every task in the previous phase has a
clean entry in `QA-REPORT.md`, CI is green, and the phase summary has been
approved. Nothing is deployed mid-phase.

Legend: ☐ not started · ◐ in progress · ☑ done (clean QA) · ⚠ done with open items

## Phase 0 — Foundation

| Task                                                        | Status | Notes                                                                                                                                        |
| ----------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 Scaffold, auth, session storage, shop-scoped Prisma, CI | ⚠      | Code and automated tests complete and green. Embedded-admin state walkthrough is blocked in this environment — see QA-REPORT 0.1 open items. |
| 0.2 Webhook framework, audit log, i18n EN/AR                | ☐      |                                                                                                                                              |
| 0.3 Billing: plans, gate middleware, Plans page             | ☐      | Blocked on a plan-ladder decision — see Open questions.                                                                                      |

## Phase 1 — Pricing engine + Pricing page

| Task                                                        | Status |
| ----------------------------------------------------------- | ------ |
| 1.1 `packages/pricing-engine` (golden vectors first)        | ☑      |
| 1.2 Shopify discount Function wired to the engine           | ☐      |
| 1.3 Pricing page: rule list, builder, priority/combinations | ☐      |
| 1.4 CSV import/export with dry-run and undo                 | ☐      |

## Phase 2 — Customers & Forms

| Task                                                              | Status |
| ----------------------------------------------------------------- | ------ |
| 2.1 Customer sync, groups, tagging, approved-buyers list          | ☐      |
| 2.2 Registration form builder, theme block, VIES, spam protection | ☐      |
| 2.3 Approval pipeline: queue, emails, auto-approval evaluator     | ☐      |

## Phase 3 — Orders

| Task                                                            | Status |
| --------------------------------------------------------------- | ------ |
| 3.1 Wholesale order list, order limits, quantity increments     | ☐      |
| 3.2 Net terms: eligibility, pay-later, ledger, reminders        | ☐      |
| 3.3 Quotes & draft orders, expiry, price locking                | ☐      |
| 3.4 Quick order storefront blocks (≤10-point Lighthouse budget) | ☐      |

## Phase 4 — AI layer (admin)

| Task                                                                | Status |
| ------------------------------------------------------------------- | ------ |
| 4.1 AI infrastructure: client, streaming, timeouts, audit hooks     | ☐      |
| 4.2 Rule-from-a-sentence + margin guard                             | ☐      |
| 4.3 Registration screening, drafted emails, segments, CSV whisperer | ☐      |
| 4.4 Merchant Agent briefing, Ask Mannon bar, PO-to-order            | ☐      |
| 4.5 Home page assembled + Setup Wizard                              | ☐      |

## Phase 5 — Storefront Buyer Agent

| Task                                            | Status |
| ----------------------------------------------- | ------ |
| 5.1 Agent service on the shopping-agent harness | ☐      |
| 5.2 Chat widget theme extension                 | ☐      |
| 5.3 Conversation log, takeover, tier upsell     | ☐      |

## Phase 6 — Analytics, Settings, polish

| Task                                                        | Status |
| ----------------------------------------------------------- | ------ |
| 6.1 Analytics: events, charts, funnel, aging, ask-your-data | ☐      |
| 6.2 Settings: all sections, agent controls, danger zone     | ☐      |
| 6.3 States sweep, Web Vitals pass, accessibility pass       | ☐      |

## Phase 7 — Release

| Task                                               | Status |
| -------------------------------------------------- | ------ |
| 7.1 Demo store seeding (3 personas, nightly reset) | ☐      |
| 7.2 Listing assets, GDPR webhooks, retention jobs  | ☐      |
| 7.3 Full regression + Built for Shopify self-audit | ☐      |

---

## Decisions taken

- **The pricing engine is a pure, dependency-free package** and never converts
  currency — an absolute-money rule in an unpriced currency is skipped, not
  converted at a rate we invented. Money is integer minor units throughout.
  `docs/adr/0006`.
- **Plan ladder: Free · Pro $29 · Growth $59 · Agentic $99** (confirmed by the
  user, 0.3). Pro is the entry paid tier and Growth the mid tier — not a typo.
  Entitlements attach to the price point; `rank` in `app/lib/billing/plans.ts`
  is the ordering, and nothing should infer one from the names.
- **Shopify Billing API, not Managed Pricing** — the checklist's Plans page
  (usage meters, downgrade impact preview, Plan Advisor) cannot live on a page
  Shopify renders. `docs/adr/0005`.

- **PostgreSQL in every environment**, not SQLite in dev — `docs/adr/0001`.
- **Fail-closed tenant isolation** via a Prisma client extension — `docs/adr/0002`.
- **Polaris web components** (`s-*`) over React Polaris, per the spec. `@shopify/polaris`
  is not installed, so nothing can accidentally import the React components.
- **i18n on i18next directly**, not through `remix-i18next` — `docs/adr/0003`.
- **One webhook registry**, drift-tested against `shopify.app.toml`, and a
  Postgres-backed job runner rather than a broker — `docs/adr/0004`.
- **Scopes start minimal** (`read_products,read_customers,write_customers,read_orders,write_draft_orders,write_discounts`)
  and each phase adds only what it needs, with a reason.

## Open questions (blocking where noted)

1. ~~**Plan ladder**~~ — resolved: Free · Pro $29 · Growth $59 · Agentic $99.

   _Original question, for the record:_ The build prompt and `…pages-features.md` §9 say
   Free / Growth $29 / Pro $59 / Agentic $99. `mannon-brand.md` §7 says
   Free $0 / Starter $9 / Growth $29 / Scale $69, with Claude features unlocking at
   Growth+. These are different products commercially — four tiers with the agent
   at $99 versus at $69, and a $9 tier that does not exist in the other. Which is
   current? Everything else in 0.3 (gate middleware, usage meters, the Plan Advisor's
   honesty rules) is unaffected and can be built either way.

2. **Product framing — non-blocking, worth confirming.** The three spec files
   describe a broad wholesale-pricing suite (rules engine, forms, limits, terms).
   `mannon-brand.md` describes a narrower quote → counter → accept → reorder product
   that "rides Shopify's native B2B and prices on draft orders — it never rebuilds
   tax, totals, or checkout". Phase 1.2 (a Shopify discount Function computing
   wholesale prices at checkout) is the suite reading, not the brand-doc reading.
   I am building to the three spec files; flagging so the divergence is a decision
   rather than a drift.
3. **Deferred from 0.3 on purpose:** the Plans page discount-code field (needs
   redemption tracking to be real, rather than a field that swallows any code);
   the ✦ Plan Advisor (needs the AI infrastructure from 4.1 and a month of usage
   to be honest); and "export offered first" on downgrade (nothing exportable
   exists until 1.4). Usage meters read zero until 1.3 and 2.2 fill in the two
   counts, as the task specifies.
4. **Deferred to 7.2 on purpose, recorded so they are not forgotten:** the three
   mandatory GDPR compliance webhooks (`customers/data_request`,
   `customers/redact`, `shop/redact`), pruning of `WebhookDelivery` rows, and the
   12-month `AuditLog` retention the checklist specifies in §8. The framework and
   the job runner take each of these as a few lines when that task comes.
5. **Repository name.** The repo is `manosa`; the product is Mannon throughout.
   Left as-is — say the word if it should be renamed.

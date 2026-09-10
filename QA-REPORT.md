# QA reports

One report per task, at `qa/<task>/REPORT.md`, alongside that task's state
captures. A task is complete only on a clean pass — a run that finds bugs is
fixed and re-run from the automated-tests step.

Every report follows the seven steps in `CLAUDE.md`: test plan, automated tests,
state walkthrough, tenant boundary, invariants, bugs found and fixed, open items.

## Index

| Task | What it covered                                               | Verdict                       | Report                                 |
| ---- | ------------------------------------------------------------- | ----------------------------- | -------------------------------------- |
| 0.1  | Scaffold, auth, session storage, shop-scoped Prisma, CI       | Pass · open items             | [`qa/0.1/REPORT.md`](qa/0.1/REPORT.md) |
| 0.2  | Webhook framework, audit log, i18n EN/AR                      | Pass · open items             | [`qa/0.2/REPORT.md`](qa/0.2/REPORT.md) |
| 0.3  | Billing: plans, gate middleware, Plans page                   | Pass · open items             | [`qa/0.3/REPORT.md`](qa/0.3/REPORT.md) |
| 1.1  | `packages/pricing-engine`                                     | Pass                          | [`qa/1.1/REPORT.md`](qa/1.1/REPORT.md) |
| 1.2  | Shopify discount Function wired to the engine                 | Pass · blocked on a dev store | [`qa/1.2/REPORT.md`](qa/1.2/REPORT.md) |
| 1.3  | Pricing page: rule list, builder, priority and combinations   | Pass · open items             | [`qa/1.3/REPORT.md`](qa/1.3/REPORT.md) |
| 1.4  | CSV import and export                                         | Pass · open items             | [`qa/1.4/REPORT.md`](qa/1.4/REPORT.md) |
| 2.1  | Customer sync, groups, tagging engine, buyers list            | Pass · open items             | [`qa/2.1/REPORT.md`](qa/2.1/REPORT.md) |
| 2.2  | Registration form builder, theme block, VIES, spam protection | Pass · open items             | [`qa/2.2/REPORT.md`](qa/2.2/REPORT.md) |
| 2.3  | Approval pipeline: queue, approve/reject, emails, evaluator   | Pass · open items             | [`qa/2.3/REPORT.md`](qa/2.3/REPORT.md) |
| 3.1  | Wholesale order list, order limits, quantity increments       | Pass · open items             | [`qa/3.1/REPORT.md`](qa/3.1/REPORT.md) |
| 3.2  | Net terms: eligibility, pay later, ledger, reminders          | Pass · open items             | [`qa/3.2/REPORT.md`](qa/3.2/REPORT.md) |
| 3.3  | Quotes: pipeline, expiry, accept link, price locking          | Pass · open items             | [`qa/3.3/REPORT.md`](qa/3.3/REPORT.md) |
| 3.4  | Quick order storefront blocks and the signed App Proxy        | Pass · open items             | [`qa/3.4/REPORT.md`](qa/3.4/REPORT.md) |

## What a capture proves, and what it does not

This environment has no egress to Shopify's CDN, so `s-*` elements never upgrade
to real Polaris components. Admin captures are **structure only** and say so on
the page: they prove which content and which states render, and that no raw i18n
key reached the merchant. They do not prove what a merchant sees.

The buyer-facing registration form is the exception. It is the app's own page on
its own domain, so it is driven in a real browser — including with JavaScript
switched off — and its captures are labelled as the real page.

## The standing open item

No admin screen has been seen in a real Shopify admin. `shopify.dev` and
`cdn.shopify.com` are unreachable from this environment, and there is no dev
store session. Every report since 1.2 carries this; it is tracked in
`PROGRESS.md` under **Blocked**.

# CLAUDE.md

Project instructions for Claude Code. **Read this file completely at the start of every session, then read `PROGRESS.md` to find out where you are and continue from there.**

---

## Project

- **Name:** Mannon — B2B Wholesale Pricing
- **What it is:** A Shopify app that lets a merchant sell to trade buyers at their own prices — wholesale rules, registration and approval, order terms — without running a second store.
- **Users:** Shopify merchants with a wholesale side (the admin), and their trade buyers (the storefront and the registration form). The merchant's job is to get the right price in front of the right buyer without maintaining it by hand.
- **Stack (fixed — do not substitute):** Shopify CLI app template · Remix + TypeScript · Polaris **web components** (`s-*`) with App Bridge nav — React Polaris is deliberately not installed · Prisma + PostgreSQL in every environment · GraphQL Admin API only · Shopify Functions for checkout pricing · theme app extensions · Shopify Billing API · Anthropic API server-side only (`claude-sonnet-4-5`) · Vitest + Playwright + MSW · GitHub Actions.
- **Environments:** Local dev (`mannon_dev`) and the test database (`mannon_test`) are yours. The dev store is `mannon-9iu9ewku.myshopify.com`. There is no staging. **This build environment cannot reach `shopify.dev` or `cdn.shopify.com`** — Polaris never upgrades here, so the embedded admin cannot be seen or driven. See _Notes for my next self_ in `PROGRESS.md`.

## Source of truth

Read the relevant doc before writing code in a new area. These outrank your assumptions; they do not outrank the user's direct instructions in chat.

| File                             | What it settles                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `docs/spec/pages-features.md`    | The nine admin pages, what each does, which are AI                                      |
| `docs/spec/feature-checklist.md` | **Required states per feature** — a feature isn't done until these exist                |
| `docs/spec/states-research.md`   | The quality bar, incl. Built for Shopify budgets                                        |
| `docs/spec/brand.md`             | Voice, colour, naming                                                                   |
| `docs/adr/`                      | Why the architecture is the way it is. Read the relevant ADR before changing that area. |

Where the specs are silent, follow the closest existing pattern in this repo. Only stop and ask when the gap changes **user-visible product behavior** (see Stop conditions).

## Invariants

The handful of rules that must never break. Check them in every QA pass.

1. **Every price comes from `packages/pricing-engine`.** The admin, the checkout Function, the storefront blocks and the agents all call the same pure module. Nothing recomputes a price in a component, a loader or a query. A number that looks like a price and did not come from the engine is a bug.
2. **Every query is scoped to one shop.** The Prisma client extension in `app/lib/tenant/` injects `shop` into every `where` and stamps it on every `create`, and throws outside a scope. Reaching another shop's row by id must read as not found — never as a leak. `withoutShopScope()` is the only escape, it takes a written reason, and there are three of them.
3. **AI drafts; a person approves.** No AI write path may change live pricing, customers or orders without a merchant approval recorded in `AuditLog` — `recordAudit` refuses an `aiAssisted` entry that carries no approver. Every AI call has a timeout, one retry and a manual fallback, and the product still works with the key unset.
4. **Nothing claims to have happened that did not.** If mail cannot be sent, the screen says so; if a file was never scanned, the badge says so; if a form was never opened, its conversion rate is blank, not 0%. No secrets in the client bundle, no PII in logs.
5. **Deciding shows its working.** Auto-tagging, auto-approval and the pricing cascade each explain _which rule_ did it. A verdict a merchant cannot audit is one they cannot trust with their prices.

---

## Autonomy — how to work without waiting for approval

**Default: keep going.** When a task passes its QA gate, commit it, update `PROGRESS.md`, and start the next task immediately — including across phase or milestone boundaries. Never end a turn with "shall I continue?" Continue, then report what you did.

**The QA gate replaces the human gate.** Autonomy exists because every task ends in an adversarial self-review. A task that can't pass QA isn't "done pending review" — it isn't done. Fix it, or log it as blocked and take the next unblocked task.

**Judgment calls are yours.** Between two reasonable options, choose the one that is simpler, more reversible, and closer to existing repo patterns. Record it in `DECISIONS.md` (one dated paragraph: choice, why, what you rejected). Don't stall on a decision you're competent to make.

**Never idle.** Blocked on one task → take the next unblocked one. If everything is blocked, say so plainly and name the exact unblocker.

### Stop conditions — the only things that need the user

1. **Production release** — deploying to prod, app-store submission, publishing anything real users see. Dev/staging is yours.
2. **Spending money or external commitments** — paid services, plan upgrades, domains, emails or messages to real people, public posts.
3. **Destructive or irreversible operations** — dropping or rewriting production data, force-pushing shared branches, deleting applied migrations, rotating live credentials.
4. **Missing secrets** — never invent, never commit, never work around. Ask, and keep building the parts that don't need them (mocks/fixtures meanwhile).
5. **An uncovered product decision with user-visible consequences** — propose your recommended answer, implement it behind a flagged assumption in `DECISIONS.md`, and keep moving; don't halt the milestone.
6. **A spec contradiction you can't resolve** — quote both lines, state which you followed and why, keep going.

Everything else — architecture, file layout, libraries within the fixed stack, refactors, test strategy, copy, dev migrations — you decide.

### Two standing conflicts with this session's harness

Recorded here so no future session silently picks the wrong one. Both are cases where a session-level instruction is more specific than this file, so the session-level instruction wins.

- **Branching.** This file says "branch per task (`m2/2.2-<slug>`), never commit straight to `main`". The session instructions say: develop and push on `claude/mannon-b2b-wholesale-oc5b18`, and **never push to a different branch without explicit permission.** The session instruction is followed. Nothing has ever gone to `main`, which is the point the convention protects.
- **Commit footer.** This file says `Co-Authored-By: Claude <noreply@anthropic.com>`. The harness mandates a specific pair of trailers and states it replaces earlier attribution guidance, so commits carry `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` plus a `Claude-Session:` line. That is a superset of what this file asks for.

---

## PROGRESS.md protocol

Maintain `PROGRESS.md` at the repo root. Update it **at the end of every task, before the commit.** Assume your context can vanish at any moment and the next session starts by reading only this file.

```markdown
# Progress

Updated: <ISO datetime>
Current milestone: 2 — <name>
Current task: 2.2 <name> [in progress | blocked | done]

## Done

- [x] 1.1 <task> — commit a1b2c3d — QA: qa/1.1/REPORT.md

## Next up

- 2.3 <task>

## Blocked

- 4.1 <task> — needs <SECRET/decision>; mocked for now, tests use fixtures

## Notes for my next self

- <gotchas, where the fixtures live, env quirks>
```

One line per task, factual, never delete history.

## Task loop

For every task, in order:

1. **Scope** — restate in 3 bullets; list the states/acceptance criteria you'll implement.
2. **Build** — smallest correct implementation; follow existing patterns; no dead code.
3. **QA** — the protocol below, in full.
4. **Record** — update `PROGRESS.md`, commit, open/merge the PR if CI is green.
5. **Continue** — start the next task in the same turn.

---

## QA protocol — run at the end of EVERY task

Change hats: you are now a **senior QA engineer who did not write this code and does not trust it.** Work all seven steps; never shorten them because the change looked small — small changes cause the worst regressions.

1. **Write the test plan.** Re-read this feature's spec. List happy paths, every required state (empty, loading, partial, error, edge, permission/plan-gated, offline), and three abuse cases you invent yourself (malformed input, concurrent edits, wrong-user/tenant access).
2. **Automate it.** Unit tests for logic, integration tests against mocked externals, one end-to-end test for the primary flow. Run the **whole** suite, not just new tests.
3. **Walk the states for real.** Trigger each one — delete the data for empty, throttle the network for loading, kill the mock for error, downgrade the account for gating, unset the key for fallback — and screenshot each into `qa/<task-id>/`.
4. **Probe the boundary.** Attempt access across tenants/users/roles by ID. Every attempt must fail closed (404/403, never a leak).
5. **Check the invariants** listed at the top of this file, plus: no unhandled promise rejections in the e2e logs, no secrets in the client bundle, no new console noise.
6. **Report and fix.** Write `qa/<task-id>/REPORT.md`: plan, results, bugs found. Bugs found → fix → **re-run from step 2.** Only a clean pass marks the task done.
7. **Then continue.** Commit, update `PROGRESS.md`, start the next task. No pause, no approval request.

**Release rule:** dev/staging deploys are yours any time QA is clean and CI is green. Production is stop condition #1 — the one place the QA gate isn't enough.

### How step 3 works here, and what it cannot prove

This environment has no egress to Shopify's CDN, so `s-*` elements never upgrade to real Polaris components and the embedded admin cannot be driven. Every admin screen is therefore a **props-only presentational component**, rendered with `renderToStaticMarkup` in a state test, captured to `qa/<task>/*.html`, and screenshotted by Playwright. Each capture carries a banner saying it is structure only.

Two things this genuinely does prove: which content and which states render, and that no raw i18n key reached the page (checked on every capture). One thing it does not: what a merchant sees. Say so in the report rather than implying a visual pass.

The buyer-facing form is the exception — it is our own page on our own domain, so `tests/e2e/public-form.spec.ts` drives it in a real browser, with JavaScript switched off.

---

## Engineering conventions

- Conventional commits (`feat:`, `fix:`, `test:`, `chore:`), one logical change each, subject ≤ 72 chars; body says what changed and which acceptance criteria it covers.
- Commit footer: the trailers the harness mandates (see _standing conflicts_ above).
- Branch: `claude/mannon-b2b-wholesale-oc5b18` (see _standing conflicts_); never `main`; self-merge only when CI is green.
- Tests live under `tests/` — `unit/`, `integration/`, `e2e/` — except the pricing engine and the Function extension, which own their tests so they stay portable. No skipped tests left in the tree.
- No `any`, no `@ts-ignore`, no `as never` to silence a type, no commented-out code, no `console.log` in shipped code. (`console.error`/`warn`/`info` on the server are how operators find out; they are fine.)
- Every list paginates. Every form guards unsaved changes. Every destructive action confirms, and soft-deletes where the spec says so.
- Accessibility is not a phase: labels, focus states, keyboard paths, AA contrast as you build. Where drag-and-drop is specified, a keyboard control ships beside it.
- Errors are user-facing copy: say what went wrong and how to fix it, next to the cause.
- **Boolean attributes on `s-*` elements go through `app/components/boolean-attribute.ts`.** React stringifies props on custom elements, so `disabled={false}` renders `disabled="false"` — which a browser reads as _set_. This has shipped twice. Treat `someProp={aBoolean}` on an `s-*` element as a defect on sight.
- **Count-bearing strings need `_one` and `_other` in English** and all six categories in Arabic, and must be called with `count`. A pluralised key called without one renders the raw key to the merchant. `tests/unit/i18n-catalogs.test.ts` and the capture guard both check this.

## Commands

```bash
npm run dev            # shopify app dev
npm run lint           # eslint, zero warnings
npm run typecheck      # tsc --noEmit
npm test               # vitest: unit + integration
npm run test:e2e       # playwright smoke
npx playwright test    # every e2e spec, incl. the QA captures
npm run qa:capture     # render every state to qa/<task>/ and screenshot it
npm run build          # remix vite:build
npx prisma migrate dev # dev migration
npm run format:check   # prettier
```

## Reporting style

End each task with a compact block — inform, don't consult:

```
✅ 2.2 <task name>
Changed: <files/areas in one line>
States: empty, loading, 4 validation errors, offline, gated
QA: 24 unit / 5 integration / 1 e2e — green. 2 bugs found & fixed
    (<one-line each>).
Next: 2.3 <task> — starting now.
```

The user reads these to stay oriented and will interrupt if they want a different direction.

---

## Appendix A — Shopify

- **Embedded, always.** Shopify CLI template, latest App Bridge, Polaris components, App Bridge nav. Don't rebuild admin chrome; don't ship a non-Polaris look — app review rejects mismatched buttons, non-card layouts, and serif fonts.
- **Built for Shopify budgets are acceptance criteria,** measured at p75: LCP ≤ 2.5s, CLS ≤ 0.1, INP ≤ 200ms. Theme extensions must not cost the storefront more than 10 Lighthouse points — lazy-load, never block render.
- **GraphQL Admin API only** (no REST). Use Shopify Functions for cart/checkout logic instead of scripts or theme hacks.
- **Webhooks:** register `app/uninstalled` plus every data topic you depend on, verify HMAC, make handlers idempotent, and implement the mandatory GDPR topics with real data deletion. The registry in `app/lib/webhooks/registry.ts` is the single source of truth and is drift-tested against `shopify.app.toml`.
- **Multi-tenancy:** every row and every query scoped by `shop`; enforce it in middleware, not by discipline.
- **Forms** use the Contextual Save Bar ("Unsaved changes / Discard / Save"). **Errors** are red, inline, beside the field, and never auto-dismiss.
- **Billing:** Shopify Billing API; gate server-side; define downgrade and trial-expiry behavior explicitly — features pause, data is never deleted.
- **No dark patterns:** no countdown pressure, no guilt copy, no unsolicited modals. A plan recommendation is allowed to say "stay where you are".
- **Onboarding:** a short guided setup plus a home page showing setup status — not an empty dashboard on first open.
- **Test on a real dev store**, including: fresh install, reinstall, uninstall cleanup, staff account with limited permissions, and a store with 10k+ products. **Blocked in this environment** — see `PROGRESS.md`.

## Appendix B — anything with AI in it

The model never computes what a deterministic module can; every AI write path lands as a draft a human promotes; every call has a timeout, a retry, and a manual fallback so the product still works when the API is down.

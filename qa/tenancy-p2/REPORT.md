# QA — tenancy cold read, P2-8

Date: 2026-09-18
Scope: P2-8 from `qa/0.1/COLD-READ.md` — four documents that no longer describe
the code, and the deferral behind two of the P0s.

---

## The deferral

`tests/integration/tenant-isolation.test.ts:177` said, in its own comment:

> No relations exist yet; assert the shape that keeps this honest as the schema
> grows — the tenant predicate is always at the top level of `where`.

Thirty-one models and twenty-eight ADRs later, nobody came back. All six
cross-tenant assertions in `qa/0.1/REPORT.md` §4 are against `Shop`: the one
model in the schema with no relations, no nested writes and no foreign keys.
That single deferral is why a nested create could write another shop's row and
a relation filter could read one, for eighteen tasks, unseen.

## What replaced it

`tests/integration/tenant-relations.test.ts` — **65 tests**. Seven probes per
relation, over every scoped model that owns one:

| Probe | What it would catch |
| --- | --- |
| read the parent by id, with its children | the `where` scope, and the `include` filter under it |
| read the child by its own id | a child reachable without its parent |
| filter children **by the parent relation** | the injected predicate merged as a branch instead of an outer AND |
| update the child by id | a cross-tenant write that succeeds |
| delete the child by id | the same, destructively |
| nested create under another tenant's parent | a write that walks in through a relation |
| nested create naming another tenant, from inside one | the composite foreign key — see below |

Plus, for each: **the tenant that owns the rows can still do all of it.** A
guard that refuses everybody is not isolation, it is an outage.

The nine relations: `CustomerGroup.members`, `CustomerGroup.limits`,
`RegistrationForm.submissions`, `RegistrationForm.events`,
`FormSubmission.uploads`, `Order.lines`, `Order.payments`, `Quote.lines`,
`AgentConversation.messages`.

### It is a map, not a sample

Two further tests read the DMMF and fail if a scoped model owns a relation that
no probe covers, or owns a second relation to a model already probed once.
Removing the `Quote.lines` probe fails with `expected ['Quote'] to deeply equal
[]` and `expected ['Quote.lines → QuoteLine'] to deeply equal []` — which is
the exact failure the original deferral should have produced in 1.3 and could
not, because there was no list to be incomplete.

### What the probes found

The extension does **not** walk a nested `create` inside an `update`:
`assertNoRetenant` checks `shop` at the top level of an update's `data`, and
`scopeCreateData` stamps nested rows only under a `create`. So
`update({ where: { id: mine }, data: { members: { create: { shop: theirs } } } })`
reaches the database unstamped.

It is refused there: every one of these relations carries a composite
`(shop, parentId)` foreign key, so a cross-tenant parent is a row Postgres will
not store (`Foreign key constraint violated on the constraint:
Customer_shop_groupId_fkey`). Fail-closed, but by the schema rather than by the
extension — which is now asserted per relation instead of assumed, and written
into ADR 0002 rather than left as a sentence in one function's comment.

**Reverted** (`scopeWhere` returns the caller's `where` unchanged): 27 of the
65 failed, across every probe. **Reverted** (the `Quote.lines` probe deleted):
the two completeness tests failed by name.

## The four documents

| Document | Was | Now |
| --- | --- | --- |
| `CLAUDE.md` invariant 2 | "injects `shop` into every `where` and stamps it on every `create`, and throws outside a scope… `withoutShopScope()` is the only escape, and there are three of them" | Names the four things that hold the line and which is which: the model-operation extension, the raw-SQL refusal, the composite foreign keys, and `withoutShopScope()` — of which there are **four**, not three |
| ADR 0002 | "throws on any Prisma operation it does not recognise" | "on any *model* operation", with the client-level raw operations stated separately, plus a new section on the two paths the extension does not reach and what holds them |
| `qa/0.1/REPORT.md` §4 | Six assertions, presented as the cross-tenant check | Amended in place, dated, saying all six are against `Shop` and what covers the rest now. History is not deleted — the wrong conclusion is the useful part |
| `tenant-isolation.test.ts:177` | "No relations exist yet" | What the test actually asserts, and a pointer to the file that covers relations |

## Invariants

2. **Shop scoping** — this round is entirely invariant 2, and it is the first
   time the invariant has been stated in a form that matches the code.
4. **Nothing claims to have happened that did not** — four documents claimed a
   guarantee wider than the one that exists. That is the same defect as a badge
   that says a file was scanned, aimed at the next engineer instead of the
   merchant.

## Suite

`npx vitest run` — **138 files, 2474 tests, all passing.**
`npm run lint` clean, `npx tsc --noEmit` clean, `npx prettier --check .` clean.

## What this round does not prove

The probes run against PostgreSQL, so the foreign-key behaviour is real. What
is still untested at the HTTP level is the 404: `qa/0.1/REPORT.md` §4 carried
that to 1.3 and it is asserted in the route tests, not here.

Relations to **unscoped** models are not probed — there are none today, and the
completeness test skips them deliberately, because `Session` has no `shop`
column to compare.

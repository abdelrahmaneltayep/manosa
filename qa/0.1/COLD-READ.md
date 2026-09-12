# Cold read — task 0.1, the multi-tenancy layer

Reviewer: adversarial cold read, no prior context on how this was written.
Base: `fd37e29` (branch `claude/mannon-b2b-wholesale-oc5b18`), working tree clean
except untracked `qa/*/cold-read/` directories.
Database: `mannon_cr2` (`TEST_DATABASE_URL`), isolated from the parallel reviews.

## Verdict: **FAIL**

Eight findings, **five of them P0 by the stated rubric** ("one shop can read or
write another's data, **or the scope can be bypassed**").

Two things must be said plainly up front, because they change how these should
be read:

1. **The by-id cross-tenant guarantee holds.** I tried to break it on eight
   models, by primary key, by globally-unique non-id column (`Quote.publicId`,
   `AgentMessage.seq`), through three relation filters, on `findUnique`,
   `findUniqueOrThrow`, `findFirst`, `update`, `delete`, `$transaction` (both
   forms), and across `Promise.all`, `setTimeout` and `queueMicrotask`. All of
   it fails closed. Twelve of my twenty-five probes are green. Invariant 2's
   headline promise is real.
2. **I found no route-reachable exploit for any of the P0s.** The application
   code is disciplined: every FK written from request input (`groupId` in
   `changeGroup`, `decideApplication`, `deleteGroup`; `conversationId` in
   `messagesForBuyer`; `orderId` in `recordPayment`) is validated with a
   *scoped* `findUnique` first, and no route mass-assigns `data` from a parsed
   body. So these are holes in the guard, not live leaks today.

That second point is exactly why they are still P0. The whole design argument in
ADR 0002 is *"Review cannot be the only control: the app will end up with
hundreds of queries across seven phases."* Where the guard does not cover, review
**is** the only control — and there is no test, no lint rule and no doc that says
which those places are. The next person to write a raw query or a nested create
gets no crash, no `CrossTenantError`, and no failing test.

**A re-run of the full gate is required after fixes.**

### How to reproduce

```
export TEST_DATABASE_URL='postgresql://mannon:mannon@localhost:5432/mannon_cr2?schema=public'
npx vitest run --config qa/0.1/cold-read/vitest.config.ts
```

25 probes: 12 pass, 13 fail. Each failure is named for the claim it breaks.
Raw output in `qa/0.1/cold-read/run.txt`. Nothing was written into `tests/`, so
the committed suite stays green.

---

## Findings

### P0-1 — Raw SQL is completely outside the guard, and does not even fail closed

`app/lib/tenant/shop-scope.server.ts:128-130`

```ts
async $allOperations({ model, operation, args, query }) {
  if (!model || !scopedModels.has(model)) {
    return query(args);       // <- $queryRaw / $executeRaw land here
  }
```

`$queryRaw`, `$queryRawUnsafe`, `$executeRaw` and `$executeRawUnsafe` are not
model operations, so `model` is `undefined` and they are passed straight
through. Three consequences, all verified:

- `db.$queryRaw\`SELECT 1\`` **outside any shop scope resolves.** It does not
  throw `MissingShopContextError`. (probe: *"refuses raw SQL with no tenant
  context"*)
- `db.$queryRaw\`SELECT "shop","email" FROM "Customer"\`` inside shop BETA
  returns **ALPHA's buyers as well**. (probe: *"raw SQL inside shop A cannot
  read shop B's rows"*)
- `db.$executeRaw\`DELETE FROM "Customer"\`` inside shop BETA **deletes ALPHA's
  buyers**; ALPHA's count goes from 1 to 0. (probe: *"raw SQL inside shop A
  cannot delete shop B's rows"*)

This directly falsifies two written claims:

- `CLAUDE.md` Invariant 2 — *"injects `shop` into every `where` … and throws
  outside a scope"*.
- `docs/adr/0002-tenant-isolation.md` — *"throws on any Prisma operation it does
  not recognise, so a future Prisma release cannot introduce a read path that
  slips past the filter."* The read path that slips past the filter is not a
  future Prisma release; it is `$queryRaw`, and it is already used.

Five call sites use it today. All five happen to be correct, and all five are
one careless edit from not being:

| File:line | Query | Filters by shop itself? |
| --- | --- | --- |
| `app/lib/jobs/handlers/purge-shop-pii.server.ts:127` | `UPDATE "AuditLog" SET "summary"…` | yes — `WHERE "shop" = ${shop}` |
| `app/lib/jobs/handlers/purge-shop-pii.server.ts:131` | `DELETE FROM "Session"` | yes — `WHERE "shop" = ${shop}` |
| `app/lib/privacy/buyer-data.server.ts:310` | `UPDATE "AuditLog" SET "metadata"…` | yes |
| `app/lib/privacy/buyer-data.server.ts:351` | `UPDATE "MonthlyReview" SET "facts"…` | yes |
| `app/lib/privacy/buyer-data.server.ts:356` | `UPDATE "MerchantBriefing" SET "items"…` | yes |

Note what these five are: **the GDPR deletion path**. The one place in this app
where a missing `WHERE "shop"` does not leak data but destroys it, and destroys
it for a merchant who did nothing. `DELETE FROM "Session"` at line 131 is one
deleted `WHERE` clause away from signing every merchant on the platform out.

*Suggested shape of a fix (not applied):* make the extension intercept
`$allOperations` where `model` is undefined and `operation` starts with
`$…Raw`, and require either an active non-bypass scope **and** a proof the SQL
is shop-filtered, or an explicit `withoutShopScope("…")`. At minimum, refuse raw
SQL when there is no scope at all, and add a lint rule restricting
`$queryRaw`/`$executeRaw` to an allow-list of files.

---

### P0-2 — `update` / `updateMany` / `upsert` can move a row into another tenant

`app/lib/tenant/shop-scope.server.ts:144-174`

`assertNoConflict` is applied to `where.shop` (line 89) and to `create.data.shop`
(line 104). It is **never applied to `data` on an update.** `WHERE_OPERATIONS`
rewrites the `where` and leaves `data` untouched.

Verified, all three, from inside ALPHA's scope:

```ts
db.customer.update({ where: { id: alphaCustomer.id }, data: { shop: BETA } })
// resolves; the returned row has shop: "beta.myshopify.com"
db.customer.updateMany({ where: {}, data: { shop: BETA } })          // { count: 1 }
db.customer.upsert({ where: { id }, update: { shop: BETA }, create: {…} })  // resolves
```

The row is now BETA's. ALPHA can no longer read it; BETA can read the buyer's
name, email, company, VAT number, credit limit and internal note. The guard
refuses `create` claiming another tenant (`CrossTenantError`, tested) but
happily lets the same row be re-tenanted a millisecond later.

TypeScript does not stop this either — `shop` is an ordinary scalar in
`CustomerUpdateInput`, so the probe file compiles clean under `npm run
typecheck`.

Probes: *"refuses an update that reassigns `shop`"*, *"…an updateMany…"*,
*"…an upsert whose UPDATE branch…"*.

---

### P0-3 — Nested creates are neither stamped nor checked

`app/lib/tenant/shop-scope.server.ts:93-108`. `scopeCreateData` recurses into
*arrays* of rows (`createMany`) but never into relation writes
(`{ lines: { create: [...] } }`, `connectOrCreate`, `connect`, `set`).

From inside ALPHA's scope:

```ts
db.order.create({
  data: {
    ...tenant(),                       // shop: ALPHA — enforced
    lines: { create: [{ shop: BETA, … }] },   // shop: BETA — passed through verbatim
  },
})
```

The created `OrderLine` comes back with `shop: "beta.myshopify.com"`. ALPHA's
own order now owns a line row stamped for BETA — which BETA's analytics,
exports and CSV downloads will happily count as their revenue.

`CLAUDE.md` says the extension *"stamps it on every `create`"*. It stamps the
top level of every create. Nested creates are a Prisma feature this repo already
uses (`orders/sync.server.ts`, `pricing/rules.server.ts`, `quotes.server.ts` all
write parent + children), so this is not a theoretical shape.

Probe: *"stamps the active tenant onto a nested create"*.

---

### P0-4 — No foreign key is tenant-checked, and `include` then reads across the line

Two halves of the same hole.

**Write half.** From BETA's scope, creating an `OrderLine` whose `orderId` points
at ALPHA's order **succeeds**. The extension stamps `shop: BETA` on the child and
never looks at where the parent lives. Same for updating BETA's `Customer` to
carry ALPHA's `groupId`.

**Read half.** Once such a row exists, the relation read hands it over, because
an `include` is resolved inside one SQL statement and is never a separate
model operation the extension can filter:

```ts
// in ALPHA
db.order.findUnique({ where: { id }, include: { lines: true } })
// -> lines[].shop === ["alpha.myshopify.com", "beta.myshopify.com"]

// in BETA
db.customer.findUnique({ where: { id }, include: { group: true } })
// -> group.shop === "alpha.myshopify.com"   <- another merchant's tier,
//    with its name, tag, discount and net-terms days
```

That second one is a straight cross-tenant read of merchant configuration
through a documented, supported Prisma call.

Note the asymmetry this creates and how easy it is to miss: filtering *through* a
relation is safe (`where: { order: { shop: ALPHA } }` returns nothing — I tested
it on `OrderLine→Order`, `AgentMessage→AgentConversation` and
`FormSubmission→RegistrationForm`, all three green), but *including* through one
is not. A reviewer who tested the first and generalised would conclude relations
are covered.

Probes: *"refuses a child row whose parent belongs to another shop"*, *"refuses a
buyer pointed at another shop's customer group"*, *"does not hand a shop another
shop's group through include"*, *"an INCLUDE through a relation cannot pull
another shop's rows"*.

---

### P0-5 — `prismaBase` is a second, silent escape hatch, and it is in use

`app/db.server.ts:8-11` says *"Only the session-storage adapter and the tenant
guard itself should ever see this."* `CLAUDE.md` says *"`withoutShopScope()` is
the only escape, it takes a written reason, and there are three of them."*

Both are false, in two separate ways.

**The `prismaBase` escape.** Three app files import it, only one of which is the
sanctioned session-storage adapter:

- `app/shopify.server.ts:67` — `PrismaSessionStorage(prismaBase)`. Sanctioned.
- `app/routes/healthz.ready.tsx:46,51,52,55` — `$queryRaw\`SELECT 1\`` plus three
  platform-wide `scheduledJob.count()` calls. A genuine cross-tenant read, done
  by importing around the guard rather than through `withoutShopScope`, so it
  carries no written reason and does not appear in any grep for escapes. The
  intent is documented in a comment and the output is counts only — the problem
  is the mechanism, not this use.
- `app/lib/webhooks/handlers/app-uninstalled.server.ts:29` —
  `prismaBase.session.deleteMany`. Gratuitous: `Session` is already in
  `UNSCOPED_MODELS`, so `db` would have behaved identically. It reads as
  "sometimes we go around the guard", which is the habit to not have.

**The count.** `withoutShopScope` has **four** call sites in `app/`, not three:
`jobs/runner.server.ts:47`, `jobs/runner.server.ts:132`,
`quotes/quotes.server.ts:130`, `forms/submissions.server.ts:84`. Each one is
genuinely unable to be scoped and each is correct — the two public-token lookups
select on a globally-unique unguessable id and immediately re-enter
`shopScope.run(found.shop, …)`; the two runner queries serve every shop and
re-enter per job. The escapes are fine. The documented count is wrong, which
matters only because the number is the thing a future reviewer checks against.

---

### P1-6 — `withoutShopScope` lets `tenant()` write a literal `"__unscoped__"` shop

`app/lib/tenant/shop-context.server.ts:112`

```ts
{ shop: current?.shop ?? "__unscoped__", bypass: true, bypassReason: reason }
```

Inside a bypass with no outer scope, `shopScope.require()` and therefore
`tenant()` return the string `"__unscoped__"`, and the extension's bypass branch
(line 137) lets the write through without checking it. Verified:

```ts
await withoutShopScope("probe", () => db.shop.create({ data: { ...tenant(), name: "ghost" } }))
// -> { shop: "__unscoped__", … }
```

A row belonging to no merchant, invisible to every tenant scope, exempt from the
uninstall purge and from every retention sweep (all of which filter by `shop`),
and impossible to find without raw SQL. No current call site does this — the
four escapes above call no `tenant()` — but `withoutShopScope` is documented as
the sanctioned hatch for *"uninstall cleanup jobs, platform-wide cron"*, which is
precisely the kind of code that writes an `AuditLog` row on its way out.

There is a second, quieter half: when `withoutShopScope` **is** called inside an
active scope it keeps `current.shop`, so `shopScope.get()` still returns the real
shop while every query sees every tenant. Code cannot tell it is in a bypass by
asking.

*Shape of a fix:* make `tenant()` and `shopScope.require()` throw inside a
bypass — there is no correct answer to "which shop am I?" when the answer is
"all of them".

---

### P1-7 — `npm run typecheck` was red on HEAD, and CI runs it — *fixed mid-review by another agent*

```
$ npm run typecheck
tests/integration/readiness.test.ts(177,17): error TS2339:
  Property 'missingOptional' does not exist on type
  '{ status: string; service: string; time: string; database: boolean;
     runnerStalled: boolean; jobs: Record<string, unknown>; }'
```

Confirmed against HEAD with my own `qa/` files excluded from the program, so it
is not mine and not the other parallel reviews'. `.github/workflows/ci.yml` runs
`npm run typecheck` as a step, so either CI is failing on this branch or the gate
is not what it is believed to be. `healthz.ready.tsx:34` typed `checks` as
`Record<string, unknown>` and spread it into the `json()` literal; TS drops the
index signature, so the loader's inferred type had no `missingOptional`, and the
test that asserts the optional-key behaviour could not see the field it checks.

**Status update.** While I was writing this report a parallel process modified
`app/routes/healthz.ready.tsx` in the shared working tree, replacing the spread
with three named fields and a comment explaining exactly this. `npm run
typecheck` is now clean. I am leaving the finding in, with two caveats: the fix
is **uncommitted** at the time of writing (`git status` shows
`M app/routes/healthz.ready.tsx` and `M app/lib/pricing/admin-graphql.server.ts`),
so it is not yet on the branch CI builds; and I did not verify it, since it is
not my change and not part of task 0.1. Whoever owns that change should confirm
it lands.

Everything else is clean: `npm run lint` — 0 errors on the repo (the only error
is in my own probe file); `npm test` — **2253 passed, 125 files, 0 failed**, no
skipped or `.only` tests in `tests/` (the only `test.skip` calls are the three
conditional guards in `tests/e2e/settings-forms.spec.ts` and
`translations-forms.spec.ts` that stand down when captures have not been
generated); no `SHOPIFY_API_SECRET`, `ANTHROPIC_API_KEY` or
`JOBS_RUNNER_TOKEN` in `build/client`.

---

### P2-8 — Documentation that no longer describes the code

Collected because each one is a sentence a future reviewer will trust instead of
testing:

- `CLAUDE.md` Invariant 2: *"injects `shop` into every `where` and stamps it on
  every `create`, and throws outside a scope"* — untrue for raw SQL (P0-1),
  untrue for nested creates (P0-3), and `withoutShopScope()` is not the only
  escape (P0-5).
- ADR 0002: *"throws on any Prisma operation it does not recognise"* — the
  unknown-operation throw at `shop-scope.server.ts:178` only fires for *model*
  operations. This part is genuinely good design and worth keeping; the sentence
  just overstates its reach.
- `qa/0.1/REPORT.md` §4 lists six cross-tenant assertions, **all against the
  `Shop` model** — the one model in the schema with no relations, no nested
  writes and no foreign keys. `tests/integration/tenant-isolation.test.ts:177`
  even says so out loud: *"No relations exist yet; assert the shape that keeps
  this honest as the schema grows."* Thirty-one models and twenty-eight ADRs
  later, nothing came back to grow it. That single deferral is the root cause of
  P0-3 and P0-4 going eighteen tasks without being seen.

---

## What I checked that is sound

Recorded so a re-run does not re-litigate it.

- **Operation coverage is complete.** I enumerated Prisma 6.19.3's model
  operations against `WHERE_OPERATIONS` / `CREATE_OPERATIONS` / the `upsert`
  branch: `aggregate`, `count`, `create`, `createMany`, `createManyAndReturn`,
  `delete`, `deleteMany`, `findFirst`, `findFirstOrThrow`, `findMany`,
  `findUnique`, `findUniqueOrThrow`, `groupBy`, `update`, `updateMany`,
  `updateManyAndReturn`, `upsert`. All seventeen are handled, and the
  default-throw at line 178 means a new one cannot slip through silently. This is
  better than most implementations of this pattern.
- **`findUnique` by primary key.** Prisma 6's extended-unique-where accepts the
  injected `shop` as an extra filter, so no silent `findFirst` rewrite is needed
  and none happens. Verified null on eight models, and on the two globally-unique
  non-id columns (`Quote.publicId`, `AgentMessage.seq`).
- **No model is unscoped by accident.** All 32 models carry a scalar `shop`;
  `Session` is the single documented exemption and
  `tests/unit/scoped-models.test.ts` fails if a new model appears with neither.
- **Async boundaries.** `Promise.all` spanning two scopes, a `setTimeout` inside
  a scope, `queueMicrotask`, a `PrismaPromise` built inside `shopScope.run` and
  awaited outside (the `settleInScope` case), array-form and interactive
  `$transaction`, and the sequential-per-shop job runner: no leak in any of
  them. Using `run()` over `enterWith()` is the right call and the reasoning in
  the comment is correct.
- **Shop selection per request cannot be influenced by the caller.** All six
  `shopScope.run` call sites take the shop from a source the caller cannot forge:
  `session.shop` (`shopify.server.ts:115`), `job.shop` (`runner.server.ts:59`),
  the HMAC-signed query string (`proxy.server.ts:150`, and `shop` is inside the
  signed payload, not a separate parameter), the verified webhook header
  (`dispatch.server.ts:36`), and `found.shop` resolved from an unguessable
  public token (`f.$publicId.tsx:56,141`, `q.$publicId.tsx:118,155`). The proxy
  additionally bounds signature age at 90 minutes and length-checks before
  `timingSafeEqual`.
- **Failing closed at the edges.** `/healthz` touches no database.
  `/healthz/ready` is deliberately unscoped and returns counts and booleans only
  — I checked the payload carries no shop name. `/internal/jobs/run` refuses
  without `JOBS_RUNNER_TOKEN` and compares it in constant time. The root
  `ErrorBoundary` (`app/root.tsx:82`) renders translated copy and never the
  error. Every by-id admin route (`app.pricing.$id`, `app.customers.$id`,
  `app.orders.quotes.$id`, `app.forms.$id`, `app.forms.upload.$id`,
  `app.customers.groups.$id`, `app.storefront-agent.log.$id`) does a scoped
  `findUnique` and throws a 404 Response on `null` — so another shop's id reads
  as not found at the HTTP layer, which is the thing `qa/0.1/REPORT.md` deferred
  to 1.3 and which I can now confirm.
- **Every FK written from request input is validated in-scope first.** This is
  why nothing above is live. `changeGroup` (`customers.server.ts:207`),
  `decideApplication` (`decisions.server.ts:202`), `deleteGroup`
  (`groups.server.ts:226`), `recordPayment` (`ledger.server.ts:66`) and
  `messagesForBuyer` (`conversation.server.ts:266`) all look the parent up
  through `db` before writing the child. `appendTurn`
  (`conversation.server.ts:106`) does not validate `conversationId` directly,
  but the scoped `agentConversation.update` in the same transaction raises P2025
  and rolls the message back — correct by accident rather than by design, and
  worth making explicit.

## What this review cannot prove

- No browser, no embedded admin, no dev store (the environment's standing
  block). Everything above is at the data and route-module layer.
- I did not audit all 53 routes for FK-from-input; I traced the ones the schema's
  relations made reachable. A fix for P0-4 should not rely on my having found
  them all.

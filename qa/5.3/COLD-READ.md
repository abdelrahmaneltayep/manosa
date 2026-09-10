# Cold read — 5.3 Guardrails panel, test mode, conversation log, publish flow

Independent adversarial review. I did not write this code and did not read the
author's report until after I had read the diff.

Commit reviewed: `baeb811` ("feat(agent): guardrails panel, test mode,
conversation log, publish flow") on `claude/mannon-b2b-wholesale-oc5b18`.
Note: the tree moved under me during the read — 5.4 (`order_lines`) work
appeared in the working tree afterwards. Everything below refers to `baeb811`.

## Verdict: **FAIL**

One requirement of checklist §6 is not met — **"'Take over' hands live chat to
merchant"**. Take-over records a merchant's reply that has no delivery path of
any kind, while the buyer's widget tells the buyer a person "will reply here"
and the admin shows a green **Sent**. That is a spec failure and an invariant-4
failure at the same time, and it is the one on this page that reaches a real
buyer.

Three further findings are invariant-4 or gating failures (P2, P3, P4), and two
are gate/isolation-adjacent (P5, P6).

What is genuinely good, said plainly because it narrowed my search: **tenant
isolation is solid on every new surface** (probe G: read, take over, reply,
close, list, export, readiness — all fail closed, all read as not found, never
as refused); **test mode writes nothing** — I traced all eight tools and every
write reachable from `answerBuyerTurn` and found only `requestQuote` and
`escalate`, both short-circuited before their write; **route wiring and ranking
are correct** (proved against Remix's own `flatRoutesUniversal` + React Router
`matchRoutes` — `log/export` beats `log/:id`); the boolean-attribute rule is
clean; there are no `.only`/skipped tests; `npx tsc --noEmit`, `npm run lint`
are green, as are the three new test files and `i18n-catalogs`.

### How to reproduce

The probes are archived at `qa/5.3/cold-read-probes/*.txt`. Copy back into
`tests/integration/` and `tests/unit/` (drop the `.txt`) and run each file on
its own. Every "Evidence" line below is captured output from those runs.

---

## P1 — HIGH — A merchant's reply to a buyer goes nowhere, and both sides are told it arrived

**Files:** `app/lib/agent/buyer/log.server.ts:167-206` (`replyAsMerchant`),
`app/components/agent/TranscriptPage.tsx:146-165`, `app/routes/proxy.agent.tsx:103`,
`extensions/mannon-storefront/blocks/buyer-agent.liquid:335-400`,
`extensions/mannon-storefront/locales/en.default.json:67`.

`replyAsMerchant` writes one `AgentMessage` row with `role: MERCHANT` and
nothing else. There is no path from that row to the buyer:

- `proxy.agent.tsx` has no GET — its loader throws `405 "Post a message to this
  address"`, and the action only answers the turn it was posted.
- The widget never fetches history or polls. Its only network call is the POST
  in the submit handler; every bubble it has ever drawn is in-memory and gone on
  reload.
- No email is sent — `replyAsMerchant` touches no `EmailMessage`.

Meanwhile:

- The buyer is told, in `en.default.json:67`: *"Someone from the team has joined
  this conversation — they'll reply here."* They will not. Nothing can appear
  there.
- The merchant is told `agent.transcript.sent` = **"Sent"**, in a success badge,
  after pressing a button labelled Send under a box labelled "Reply as
  yourself".

**Failure scenario.** A buyer asks for a better price on 500 units. The merchant
opens the transcript, presses Take over, types "Yes — 12% on 500 units", presses
Send, sees "Sent", and closes the tab. The buyer refreshes, sees nothing, waits,
and eventually goes elsewhere. Nobody involved has been told the truth.

**Evidence (probe E):**

```
PROBE E buyer's next turn: {"conversationId":"...","reply":null,"cart":null,
  "quote":null,"tool":null,"failure":"taken_over","refusal":null}
PROBE E stored roles: [ 'BUYER:hello?|', 'MERCHANT:Yes — I can do 12% o|' ]
```

The merchant's text is in the database and the buyer's next turn gets nothing
but the generic `taken_over` failure string.

**Fix — pick one, do not ship neither:**
(a) deliver it: a signed App Proxy GET the widget polls **only while
`takenOverAt` is set**, returning `MERCHANT` messages since a cursor; or
(b) deliver it by email through the existing transport; or
(c) tell the truth on both sides — the buyer string stops promising a reply in
the widget, and the admin says where the reply actually goes. (c) is honest but
makes the checklist item "hands live chat to merchant" still unmet, so it needs
a `DECISIONS.md` entry and a `PROGRESS.md` deferral, not silence.

## P2 — HIGH — The take-over announcement renders in the transcript as "the agent couldn't answer"

**Files:** `app/lib/agent/buyer/log.server.ts:141-150` writes the announcement as
`{ role: AGENT, text: "", refusal: "taken_over" }`;
`app/components/agent/TranscriptPage.tsx:73-79` renders **any** empty text as
`agent.transcript.emptyTurn` = *"The agent couldn't answer this one. Nothing was
sent to the buyer."*

**Evidence (probe M — the component rendered with the exact rows `takeOver` and
`replyAsMerchant` write):**

```
|Escalated|Started 2 hours ago
|Buyer|1 hour ago|can you do better on 500?
|Agent|1 hour ago|The agent couldn&#x27;t answer this one. Nothing was sent to the buyer.|Why: taken_over
|You|55 minutes ago|Yes — 12% on 500 units.
|You took this conversation over 1 hour ago. The agent is no longer answering it.
```

So the one row that exists to say "a person joined here" says the agent failed.
That is invariant 4 on the screen invariant 4 was written for.

**Why the author's gate missed it:** the state fixture at
`tests/unit/agent-pages-states.test.tsx:499-508` produces
`32-transcript-taken-over` by flipping `takenOver: true` on the *same two turns*
as the happy path. No capture in `qa/5.3/` has ever contained the announcement
row, and none has ever contained a `MERCHANT` turn either — so the "You" badge
and the merchant's own bubble have never been rendered in the state walk. The
fixture does not match what the writer writes; that is the exact bug shape
`PROGRESS.md` records from 4.5 ("a fixture that sets a column the production
writer never sets is a test that cannot fail"), inverted.

**Fix:** give the announcement its own copy (`refusal === "taken_over"` →
"A person joined this conversation") before the empty-text branch, and build the
taken-over capture from real `takeOver` output.

## P3 — MEDIUM — "The agent is live" is claimed without checking the app embed, which this app can check

**Files:** `app/lib/agent/buyer/publish.server.ts:107-127`,
`app/i18n/locales/en.json` → `agent.publish.liveBody`,
`extensions/mannon-storefront/blocks/buyer-agent.liquid:405-418` (`"target": "body"`).

Checklist §6: *"Publish = theme block enable + confirmation with storefront
link."* `publishAgent` flips a database flag and nothing else. The block is an
**app embed** (`target: body`), which is off until the merchant switches it on
in the theme editor. After publishing, the panel says:

> The agent is live — Approved buyers who are signed in can chat with it on your
> storefront.

For a merchant who has not enabled the embed, that sentence is false and there
is nothing on the page that hints at it: no embed status, no deep link, no
caveat. I read every string under `agent.publish.*` — none mentions the theme.

The app already knows how to answer this honestly:
`app/lib/setup/checklist.server.ts:48-64` uses `Shop.storefrontSeenAt` (set by
`withProxy`, "the one honest signal that the app embed is live") plus
`embedConfirmedAt` as the merchant's attestation. 5.3 ignores both.

**Also a refuted report claim.** `qa/5.3/REPORT.md` §7 says of this gap
"*Stated on the screen — the storefront link is where the merchant checks.*" It
is not stated on the screen. Nothing on the screen mentions the app embed.

**Fix:** read the same two columns; when neither is set, the Live banner says
"we haven't seen your storefront call us yet — check the Mannon app embed is on"
with the theme-editor link, exactly as Home does.

## P4 — MEDIUM — The publish/save/review action has no plan gate at all

**File:** `app/routes/app.storefront-agent._index.tsx:80-137`. The loader
computes `entitled` for display; the action never calls `loadEntitlements()`.
Compare `app.storefront-agent.test.tsx:56-71` (gates, correctly) and
`app.storefront-agent.log.export.tsx:17` (402, correctly). CLAUDE.md: "Billing:
gate server-side"; the panel's own comment says "a disabled button is a
courtesy, not enforcement" — on the one route where it is the only enforcement.

**Evidence (probe C):** on plan `free`, with the checklist satisfied:

```
PROBE C entitled: false published: true
```

The panel then displays "The agent is live", while `proxy.agent.tsx:37` answers
every storefront turn with 402 and the widget hides its launcher. A downgraded
merchant is told their agent is serving buyers when it is switched off — the
billing rule says features pause, but this one pauses while claiming not to.

**Same gap, smaller blast radius:** `app/routes/app.storefront-agent.log.$id.tsx:108-131`
— `takeOver` and `replyAsMerchant` run with no entitlement check.

## P5 — MEDIUM — A rehearsal spends the real buyer's storefront rate-limit budget

**File:** `app/lib/agent/buyer/conversation.server.ts:200-221`. `overTurnLimit`
counts `role: "BUYER"` messages joined through `conversation: { customerId }`
with **no `testMode` filter**. A merchant's rehearsal stores its messages as
`BUYER` turns against that customer id, so they are counted.

**Evidence (probe B), limit forced to 2 to keep the probe short:**

```
PROBE B before: false   after two rehearsal turns: true
```

**Production scenario.** A merchant rehearses 20 turns as Café Aroma while
tuning their off-limits list. Café Aroma opens the widget nine minutes later and
gets `rate_limited` → *"You've asked a lot of questions recently"*. They asked
none. The ADR's own framing is that a rehearsal changes "exactly two things";
this is a third, and it is the only one that touches something real.

**Fix:** `testMode: false` in the `conversation` filter of `overTurnLimit` (and
consider a separate, smaller ceiling for rehearsals so the panel still cannot
run away).

## P6 — MEDIUM — The fourth publish item ticks on a scripted decline that needs no model call and no API key

**Files:** `app/lib/agent/buyer/rehearsal.server.ts:58-65` (`outcome: { not: "FAILED" }`),
`app/lib/agent/buyer/turn.server.ts:182-209` (off-limits branch records
`DECLINED` **before either model call**).

The ADR says item four is "a rehearsal the agent actually **answered**" and that
"a rehearsal that only ever failed proves the opposite of what this item is
asking". A scripted off-limits decline is neither: no model was called, no price
was quoted, nothing about this agent was rehearsed.

**Evidence (probe A) — `ANTHROPIC_API_KEY` deleted and the client reset first:**

```
PROBE A turn: {"reply":"That's not something I can help with here — ...",
  "tool":"decline","failure":null,"refusal":"off_limits"}
PROBE A completed: true
PROBE A items: [rule:true, buyer:true, reviewed:true, test:true]
PROBE A published: true
```

So: a shop with **no working AI at all** publishes a Buyer Agent to its
storefront, having satisfied the "test conversation completed" gate with one
message that the model never saw. Every subsequent real buyer turn will fail
with `no_key`.

**Fix:** tick on evidence of a completed model turn — e.g. `outcome IN
(ANSWERED, CART, QUOTE, ESCALATED)`, or the existence of an `AgentMessage` in
that conversation with `role: AGENT` and `aiModel != null`. The second is the
stronger statement and is already stored.

## P7 — MEDIUM-LOW — The guardrails form has no contextual save bar and no unsaved-changes guard

**File:** `app/components/agent/GuardrailsPage.tsx:29-44`. Four other editable
forms in this repo use `<ui-save-bar>` (`orders/LimitsPage.tsx:235`,
`customers/GroupDetailPage.tsx`, `pricing/RuleBuilderPage.tsx`,
`forms/FormBuilderPage.tsx`). CLAUDE.md: "Every form guards unsaved changes";
Appendix A: "Forms use the Contextual Save Bar".

The navigation that loses the work is *inside the same page*: `AgentTabs` sits
above the form, so "type a new off-limits subject → click Test mode to try it"
discards it silently. That is the most likely thing a merchant does on this
screen.

## P8 — LOW — The capture guard is switched off for this entire page family

**File:** `tests/support/state-capture.tsx:94-115`. `CATALOG_ROOTS` has no
`"agent"` entry, so `expectNoRawCatalogKeys` checks none of 5.3's 24 captures
for raw `agent.*` keys. This is verbatim the gotcha `PROGRESS.md` records
("4.2 added `describe` — the guard was silently not covering the new page until
then"), repeated.

I grepped all 24 captures for `>...agent.<key>` and found none, so this is a
missing guard rather than a live defect — but `qa/5.3/REPORT.md`'s claim that
the captures prove "no raw i18n key reached a page" is unsupported for 5.3.

Two live routes into a raw key that the guard would have to catch:

- `app/routes/app.storefront-agent._index.tsx:61` passes `searchParams.getAll("refused")`
  through unvalidated to `GuardrailsPage.tsx:86`, which renders
  `t("agent.publish.step." + step)`. `/app/storefront-agent?refused=nonsense`
  prints `agent.publish.step.nonsense` to the merchant.
- `view-model.server.ts:152-171` reads `tool` out of stored JSON and
  `TranscriptPage.tsx:89` renders `t("agent.tool." + tool)`; a row written by a
  future version with a new tool name prints the key.

## P9 — LOW — Take over is not idempotent under concurrency

**File:** `app/lib/agent/buyer/log.server.ts:130` — read-then-write with no
condition on the update.

**Evidence (probe H), two simultaneous `takeOver` calls:**

```
H announcements: 2
H audit entries: 2
```

`qa/5.3/REPORT.md` §3 claims "Taking over is idempotent — two presses announce
once". True sequentially; false for a double-click or a retried request. Fix:
`updateMany({ where: { id, takenOverAt: null }, ... })` and only announce when
`count === 1`.

## P10 — LOW — Taking over rewrites what the log says happened

`takeOver` sets `outcome: "ESCALATED"` directly instead of going through
`recordOutcome`, whose whole job is "the strongest thing that happened wins".

**Evidence (probe D):** a conversation with `outcome: CART` reads `ESCALATED`
after take-over. The merchant's log now says no cart was built in a conversation
that built one. Same in `replyAsMerchant:200-202`.

## P11 — LOW — A long merchant reply is silently truncated

`log.server.ts:174` slices at 2,000 characters. The textarea has no `maxLength`,
no counter, and the merchant still gets "Sent".

**Evidence (probe I):** typed 2,500, stored 2,000.

## P12 — LOW — `saveGuardrails` still accepts `published`

`app/lib/agent/buyer/guardrails.server.ts:55,102-107` — a second publish path
with no checklist re-check. No app caller today (tests only), so it is dead
weight that quietly undoes the gate the first time somebody reuses it. Either
delete the field and have the tests call `publishAgent`, or make it private to
the module.

## P13 — LOW — `exportConversations` is unbounded and ignores the merchant's filters

`log.server.ts:211-250`: every message of every conversation in the shop, loaded
in one `findMany` with `include: { conversation: true }`, joined into one string
in memory. No pagination, no streaming, no date window. Ninety days of a busy
shop is the failure case, and it fails as a timeout on the merchant's download.
Separately, the Export CSV link sits inside the filter toolbar
(`ConversationLogPage.tsx:112`) but exports everything regardless of the active
outcome/search filter — which reads as a filtered export and is not one.

## P14 — LOW — The rehearsal buyer picker caps at 50 and silently substitutes

`view-model.server.ts:36-44` takes 50 approved buyers ordered by company;
`rehearsal.server.ts:98-103` falls back to `buyers[0]` for any id outside that
window. A shop with 200 approved buyers cannot rehearse as most of them, and
`?buyer=<a genuinely approved id>` answers as a *different* buyer, with that
buyer's prices and terms, saying nothing about the substitution. Convention:
"Every list paginates."

## P15 — NIT — Dead view data, one of it a query per page load

`GuardrailsView.conversations` and `.retentionDays` are computed and never
rendered — including `db.agentConversation.count()` in the loader
(`app.storefront-agent._index.tsx:49`). `TestView.buyerName` is likewise unused.

## P16 — NIT — Machine refusal codes shown to the merchant

`agent.transcript.refusal` = "Why: {{reason}}" renders raw enum values:
"Why: taken_over", "Why: test_mode", "Why: off_limits: supplier", "Why:
quote_off". Untranslated in Arabic too, since the value never goes through the
catalogue.

## P17 — NIT — The attestation records no audit entry

`markGuardrailsReviewed` writes `reviewedAt` and `updatedBy`, but `updatedBy` is
overwritten by the next Save, so "who said they had reviewed the guardrails
before this thing went live" is not durably recorded anywhere — on the one
screen whose output talks to customers. `publishAgent` records an audit entry
but not which four items were true at the time (invariant 5).

---

## Invariant check

| Invariant | Result |
| --- | --- |
| 1 — every price from the engine | **Pass.** 5.3 adds no arithmetic. The rehearsal cart renders `PricedToolLine` values produced by `priceLine`; nothing in the new components or view models computes or reformats money. |
| 2 — every query shop-scoped | **Pass.** Probe G: `readConversation` → null, `takeOver`/`replyAsMerchant` → `Response 404`, `listConversations` → 0 rows, `exportConversations` → header only, `closeRehearsal` from the wrong shop leaves the row open, `publishReadiness` sees none of the other shop's rule/buyer/rehearsal. All fail closed as not-found, never as refused. |
| 3 — AI drafts, a person approves | **Pass with a caveat.** Test mode's two writing tools are off and say so; publish is a person's decision. The caveat is P6: the "person approves" gate can be satisfied without the model having run. |
| 4 — nothing claims what did not happen | **FAIL.** P1 (both sides told a reply was delivered), P2 (announcement rendered as a failure), P3 ("the agent is live" without the embed), P4 ("live" on a plan that refuses every turn), P5 (a real buyer told they asked a lot of questions when they asked none). |
| 5 — deciding shows its working | **Pass.** Transcript shows tool + facts, rehearsal cart shows the rule per line, the lint quotes the merchant's phrase, publish names each outstanding item. Minor gap in P17. |
| No secrets in the client bundle | **Pass by construction.** Every new server module is `.server.ts`; `app/components/agent/*` import only React, i18next and local types. No key or prompt text is reachable from a component. |
| No skipped or `.only` tests | **Pass** (grepped the three new files). |
| No new console noise | **Pass.** Two `console.error` in `tools.server.ts` (allowed on the server); no `console.log` anywhere in the new code. |
| No value computed in a component | **Pass.** All three pages are props-only; every decision is in `view-model.server.ts` / `publish.server.ts`. |
| Boolean attributes on `s-*` | **Pass.** Every one goes through `whenDisabled`/`whenChecked`; no raw boolean prop in `app/components/agent/`. |
| Pluralised keys called with `count` | **Pass.** `agent.log.turns` is the only count-bearing key and is called with `count`; `i18n-catalogs` green. |

## What I ran

```
npx tsc --noEmit                                   clean
npm run lint                                       clean
npx vitest run tests/integration/agent-panel.test.ts        27 passed
npx vitest run tests/unit/i18n-catalogs.test.ts \
    tests/unit/agent-panel.test.ts \
    tests/unit/agent-pages-states.test.tsx                  54 passed
npx vitest run <probe suite 1>                     6 probes, all confirmed
npx vitest run <probe suite 2>                     6 probes, all confirmed
npx vitest run <render probe>                      1 probe, confirmed
node — Remix flatRoutesUniversal + matchRoutes ranking      correct
```

I did **not** run the full suite or Playwright: the instruction for this read was
to avoid concurrent vitest runs against the shared `mannon_test` database, and
the build agent was already writing to it (a `20260910194556_order_lines`
migration applied mid-read). The author's whole-suite claim is therefore
unverified by me, not disputed.

## What this read cannot prove

The same limits as the author's: no merchant has seen these screens (Polaris
never upgrades here), no conversation has ever been held with Claude, and the
publish switch has never met a theme. P3 in particular is a bug I can only prove
by reading the block's `target` and the copy — the actual "merchant with the
embed off" walkthrough needs a dev store.

## Re-run required

Fix and re-run from step 2 of the QA protocol. P1, P2, P4 and P6 each need a new
regression test; P2's must be built from the rows `takeOver` actually writes, not
from a hand-made view.

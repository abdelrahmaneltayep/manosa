# Cold read — 6.5 ✦ Agent controls

Independent adversarial review. Commit `5babb43` (+ `51e6966` docs).
Reviewer: senior QA engineer who did not write this code and does not trust
`qa/6.5/REPORT.md`.

## Verdict: **FAIL**

The task's stated purpose is *"a merchant can say what Claude may do"*. On the
loaders it holds. **On the paths that actually call Anthropic — the POST
handlers and one GET side-effect — it does not.** With `aiMayDraft` switched
off, four ✦ surfaces still send the merchant's data to the model, three of them
from a form the loader has already decided not to offer. That is the 6.4 P0 in
a different costume, which is the specific thing this review was asked to look
for.

Separately, the surface the ADR leads with — ✦ Screening — now tells a merchant
who switched screening off that *"this store has no Anthropic key"*. The task
exists to stop that sentence being the only answer available; it instead made
it false.

Everything the author claims about the suite is true and was re-verified:
`npm test` 2,091/112 green, `npx playwright test` 403 green, lint / tsc /
build / format:check all clean. **Green is not the problem. What the suite
never asks is the problem** — there is not one test in the tree that posts to a
✦ action with a permission switched off.

---

## Findings

Ranked by what hurts a merchant.

### P0

**1. The gate does not gate the POST. Four ✦ surfaces call Claude with the
permission switched off.**

Every converted call site is of the form `(await aiGate("draft")).allowed`
assigned into a *view*, and then never used as a guard. `app.orders.po.tsx:173`
and `app.setup.tsx:158` do it right (`if (!base.available) return 402`). These
four do not:

| File · line | What runs anyway |
| --- | --- |
| `app/routes/app.pricing.describe.tsx:122` → `:138` | `aiAvailable` is computed, spread into `common` for the view, and never read as a condition. `intent=draft` calls `draftRuleFromSentence` regardless. |
| `app/routes/app.customers.segments.tsx:196` → `:213` | `base` (which contains `base.aiAvailable`) is built at the top of the action and never checked. `intent=draft` calls `draftSegment` regardless. |
| `app/routes/app._index.tsx:69` → `:79` | `intent=ask` calls `routeAsk` with **no permission check and no plan check**. `buildView` computes `agentAvailable` for the loader only. A Free-plan shop can drive the Merchant Agent by POST. |
| `app/routes/app.customers.applications.tsx:90` → `:91` | ✦ Drafted email runs off `?draft=1` in the **loader**, gated by nothing at all — not `aiGate`, not even `isAiAvailable()`. |

Reproduce (no key needed — the failure is that the call is *attempted*; with a
key it completes):

```
1. Settings → ✦ Agent controls → untick "Let Claude draft messages,
   rules and reviews" → Save.
2. Pricing → ✦ Describe a rule. The button renders disabled
   (RuleListPage/DescribeRulePage use whenDisabled(!view.aiAvailable)).
3. POST /app/pricing/describe   intent=draft&sentence=10%25+off+for+wholesale
   → a model call is made and an audit row `pricing_rule.drafted` is written.
   Same shape: POST /app/customers/segments intent=draft
               POST /app/           intent=ask&question=...
   And by plain link: GET /app/customers/applications?edit=<id>
                          &intent=reject&draft=1
```

`app/routes/app.storefront-agent.test.tsx:60` has the right sentence in a
comment — *"Server-side, like every other gate in this app: a disabled button
is a courtesy, not enforcement"* — and it is exactly the rule these four break.

Why it is P0 and not P1: the merchant's answer to "may Claude read/write my
data" is the whole feature, the data leaving the shop is a third-party
disclosure they declined, and it is billable. `docs/adr/0027`'s own rejected
alternative ("checking permission at the prompt layer… a page that renders the
✦ button, takes the click, and only then discovers it is not allowed has
already lied") describes a *better* state than what shipped: here nothing
discovers it at all.

### P1

**2. Switching screening off tells the merchant the store has no API key.**

`app/lib/jobs/handlers/screen-applications.server.ts:42` now stamps
`screening: "OFF"` when `aiGate("screen")` is closed for *any* of its reasons.
`app/components/customers/ApplicationsPage.tsx:300` renders
`applications.screening.off`, whose English (`app/i18n/locales/en.json`) is:

> "✦ Screening is off — **this store has no Anthropic key**. Review this one
> yourself; it has never blocked approving anybody."

Repro: untick "Let Claude read new registration applications", save, let
`forms.screen_applications` run over a waiting application, open
`/app/customers/applications`. The merchant is told a fact about the
deployment that is false, and sent to fix something that is not broken.
Invariant 4. This is the precise sentence ADR 0027 says the task exists to
replace ("the screen could only say 'no key' — never 'you switched this
off'"), and 6.5 made it wrong instead of replacing it. `AiGate.blockedBy` is
returned and thrown away at every one of the fifteen call sites — the only
consumer in the tree is `daily-briefing.server.ts:46`, which puts it in a job
result no screen reads. `requiredPlan` is never set to anything but `null`.

**3. The brand-voice card promises tone-matching that no prompt does.**

`app/i18n/locales/en.json`, `settings.agent.voiceBody`: *"Paste 3 messages you
have actually sent a buyer, and **Claude will match your tone** instead of
inventing one."* and `voiceFull`: *"That is **as many samples as Claude
reads**."* Nothing reads them — `grep -rn brandVoiceSample app/` returns only
`brand-voice.server.ts` and the settings view model; no prompt in
`app/lib/ai/prompts/` imports it. `qa/6.5/REPORT.md` §8 states the opposite:
*"until then the card does not claim they are in use"*. It does, twice, in the
two strings a merchant reads first. Visible in `qa/6.4/15-agent-no-key.png`.
Invariant 4, and the claim in the report is not true.

**4. "Filterable by action" ships a picker in which 11 options read
"Pricing" and 10 read "Activity".**

`app/routes/app.activity.tsx:99` labels each option with
`activityKindLabel(value, t)`, which is the *family chip* — it maps
`pricing_rule.*` → "Pricing", `form.*` → "Registration", and anything outside
its 16-family list → "Activity". Measured over the 65 action strings in the
codebase:

```
 11  Pricing      10  Activity     10  Registration    6  Quote
  5  Buyer         4  Tagging       3  App             3  Groups
  3  Order         2  Plan          2  Agent           2  Segments
  2  Terms         1  Setup         1  Shop
```

A merchant cannot tell `pricing_rule.created` from `pricing_rule.archived`
from `pricing.ruleset_published`. The two actions **this task itself writes**
(`settings.brand_voice_added`, `settings.brand_voice_removed`) both render as
"Activity", as do `agent.*` and `order_limit.*`. Checklist §8's "filterable by
… action" is not met in any usable sense.

Why no test caught it: the fixture in
`tests/unit/setup-pages-states.test.tsx:92` hand-writes
`{ value: "pricing_rule.created", label: "Pricing" }` and
`{ value: "form.approved", label: "Registrations" }` — two values, two
distinct labels, implying a 1:1 mapping. The producer emits "Pricing" and
"**Registration**" (singular), so the fixture is not even a value the producer
can make. This is the "a fixture written from the catalogue is not a fixture
from the producer" defect, verbatim from `PROGRESS.md`, on the task after the
one that wrote the note. The capture cannot catch it either: the stand-in
renders `s-select` as an empty box and never draws `s-option` text
(`qa/4.5/09-activity-log.png`).

**5. Five `isAiAvailable()` call sites survived the sweep, on a ✦ surface.**

`app/routes/app.storefront-agent.test.tsx:44,69,82,99,118`. The rehearsal page
sends a merchant-typed message through `answerBuyerTurn` with `testMode: true`
— a real model call — gated on the key and the plan only. ADR 0027 and the
commit message both state "all fifteen now call `aiGate`"; the sweep is 15 of
20, and the five it missed are on the page where a merchant types free text at
Claude. `git grep isAiAvailable app/` is the whole audit.

### P2

**6. The retention job is scheduled from exactly one page, and it is not the
page that makes the promise.**

`ensureAuditPurgeScheduled` is called only from `app/routes/app.activity.tsx:66`.
`app/lib/shop/ensure-shop.server.ts` enqueues `agent.daily_briefing`,
`orders.backfill` and `customers.backfill` at install and **not** `audit.purge`.
Settings → ✦ Agent controls states *"kept for 365 days"*
(`settings.agent.retention`, rendered in `SettingsPage.tsx:430`) and schedules
nothing. A merchant who reads the promise in Settings and never opens the log
has an audit table that grows forever. One line in `ensure-shop.server.ts`
fixes it.

**7. The log states a history that does not exist.**

`app/routes/app.activity.tsx:100` sets `keptFrom = retentionCutoff(now)`
unconditionally, and `activity.retention` renders *"Kept for 365 days — this
log goes back to 2025-06-01."* For a shop installed last week that date is
before the install. Visible in `qa/4.5/09-activity-log.png`. Invariant 4 —
`max(cutoff, installedAt)` is the true answer.

**8. The purge deletes the only record that an AI-assisted change was
approved, while the change stays live.**

`purge-audit.server.ts:46` is `deleteMany({ createdAt: { lt: cutoff } })` with
no exemption. `AuditLog.aiAssisted` + `approvedById` + `approvedAt`
(`prisma/schema.prisma:327-329`) are, per the schema's own comment and
Invariant 3, the record that "no AI write path mutated live pricing or
customers without a merchant approval". After 365 days a pricing rule Claude
drafted and a merchant approved is still pricing checkouts with nothing
anywhere saying who approved it. §8 says "Retention 12 months" and Invariant 3
says the approval must be recorded; the two conflict and nothing in
`DECISIONS.md`, `docs/adr/0027` or the report notices. Per CLAUDE.md stop
condition 6 this needed quoting both and picking one.

**9. `BrandVoiceSample` is not reached by the uninstall purge.**

`app/lib/jobs/handlers/purge-shop-pii.server.ts` redacts `AuditLog`, clears
`Shop.name/email` and deletes `AgentConversation`. The new table holds messages
the merchant *actually sent buyers* — names, order references, addresses — plus
`createdBy`. It has no relation and so is in no cascade. Settings says *"If you
uninstall Mannon, everything it stored about your shop is deleted within 48
hours"* (`settings.danger.uninstallPolicy`). The code's own reasoning for
deleting conversations ("a buyer's own words to a merchant who no longer has
this app") applies unchanged. `PROGRESS.md` records one table 7.2 must reach;
this makes two, and nobody wrote it down.

**10. The category links throw the new filters away.**

`app/components/activity/ActivityPage.tsx:21` —
`href={`/app/activity?filter=${filter}`}`. A merchant filtered to
*Claude · 1–7 Sep* who clicks "Pricing" silently loses actor, action, from and
to. `keeping()` was written for exactly this and is used only by "Show older"
(`app.activity.tsx:104`). Same at `:61` — "Clear filters" is the only link that
*should* drop them, and it is also the only one that renders conditionally on
`view.filtered`, which excludes the category, so a category-only filter has no
clear link.

**11. A brand-voice validation error wipes the pasted message.**

`app/routes/app.settings.tsx:102` passes `echo: form` into `settingsView`, but
`SettingsPage.tsx:487` and `:494` hard-code `value=""` on the label field and
the body text area. Repro: paste a 3,000-character email into "The message",
leave "What this is" blank, press "Add this sample" → 422, the error renders,
and the 3,000 characters are gone. Every other field on this page echoes
(`typed()` in `view-model.server.ts`); these two do not.

**12. One third of `aiGate` is dead, and a comment says otherwise.**

No call site in `app/` passes `options.feature`, so the `blockedBy: "plan"`
branch (`permissions.server.ts:71-75`) is unreachable in production and
untested — every caller still does its own separate `hasFeature`.
`requiredPlan` is declared on the interface, documented ("the plan this needs"),
and assigned `null` in all four returns. `aiPermissions()` (`:84`) has no
caller outside `tests/integration/agent-controls.test.ts` — the settings view
model reads `shop.aiMayScreen` directly. Meanwhile
`screen-applications.server.ts:39` comments *"Three reasons this can be off —
… the plan does not include it … and `aiGate` is the only place that knows all
three"* on a call that passes no feature and therefore never checks the plan.

**13. Deleting the merchant's own writing takes one click, with no
confirmation.**

`SettingsPage.tsx:471` posts `intent=removeSample` straight from a button;
`brand-voice.server.ts:71` hard-deletes ("Removed for good"). CLAUDE.md:
*"Every destructive action confirms, and soft-deletes where the spec says so."*
The Danger Zone on the same page does confirm (`qa/6.4/10-danger-confirm.png`);
this does not. There is no undo and the body is not recoverable.

**14. The one test that would have caught a 6.4-style nested form does not
cover the new section.**

`tests/e2e/settings-forms.spec.ts:26` — `SECTIONS` still lists six and was not
extended with `"agent"`, and the count assertion is
`toBeGreaterThanOrEqual(SECTIONS.length)`, so three new forms cannot fail it.
I ran the browser parse myself and the markup is in fact **correct** — nine
forms, no nesting, `section=agent` posts with no stray `intent`, and the
brand-voice forms sit outside the section form as `Section`'s `after` prop
intends. So this is a missing guard, not a live defect; the next person to add
a control there has no net.

**15. The Buyer Agent is outside these toggles entirely, and the card reads as
if it were not.**

`app/routes/proxy.agent.tsx:36` gates on the plan and the turn ceiling and
nothing else. It is the one path where Claude writes to a *buyer* without a
merchant in the loop, and it autonomously builds carts and raises quotes. The
agent-controls card says *"Nothing here lets Claude change a price, a customer
or an order on its own"* with no mention that the storefront agent is governed
somewhere else (the 5.3 publish flow). Either the copy should name the
exclusion or the Buyer Agent should read a permission.

**16. The report claims states that were never captured, and one that does not
exist.**

`qa/6.5/REPORT.md` §2 lists nine conditions as walked. `qa/6.4/` holds 13
captures, 12 of which pre-date this task; `15-agent-no-key` is the only new
one, and the default agent card rides along inside `01-settings`. No capture
exists for: five samples / "voiceFull", a muted briefing beyond the single
fixture row, a filtered log, the `emptyFiltered` branch, the brand-voice
validation error, or entries older than 12 months. The first row of the table —
*"Screening off → that ✦ surface says you switched it off, not 'no key'"* — is
not a capture gap but finding 2: no surface says it, and the one that speaks
says the opposite. The report's Invariant-5 paragraph ("so a ✦ surface can say
'you switched this off'") describes a capability nothing exercises.

### P3

17. **`MAX_SAMPLES` loses a race — measured.** `brand-voice.server.ts:46-47`
    is `count()` then `create()`. Eight concurrent `addSample` calls in one
    tenant stored **7** samples. The UI then hides the add form
    (`SettingsPage.tsx:441`) and says "that is as many as Claude reads" beside
    seven of them.
18. **365 days is not twelve months.** `AUDIT_RETENTION_DAYS = 365` with a
    plain ms subtraction; across 29 Feb the window is a day short of the
    promise, and the copy states the number rather than the month.
19. **`settings.agent.mutedUndo` is wrong.** *"Unmute one from the briefing on
    your home page the next time it would have appeared."* `HomePage.tsx:120`
    (`Muted`) lists every muted kind with an unmute button unconditionally,
    now. The copy tells a merchant to wait for something they can do
    immediately.
20. **A long label is silently truncated.** `brand-voice.server.ts:52` —
    `label.slice(0, 120)` with no `BrandVoiceInvalid`. A 300-character label is
    cut without a word to the merchant, and `settings.issue.label` has no code
    for it.
21. **`keeping()` emits `/app/activity?&before=…`** when no filter is set
    (`app.activity.tsx:36-42` — empty `URLSearchParams`). Harmless, ugly, and
    the fixture at `setup-pages-states.test.tsx` hand-writes a `nextHref` the
    route would not produce.
22. **An inverted range says "Nothing of this kind yet."** `from` later than
    `to` yields zero rows (verified) with no hint the dates are backwards.
23. **Two migrations, the second undoing the first.**
    `20260911123138_agent_controls` adds `aiMayAutoApprove`;
    `20260911123310_agent_controls_two` drops it, in the same commit.
24. **The add-sample form has no unsaved-changes guard.** Only the section form
    carries `data-save-bar`; a pasted email is lost on navigation.
25. **"Watched fail" is 4 of 13, not 3 of 10 + 3.** I re-ran the author's two
    mutations (`permissions.server.ts:64` short-circuited, `retentionCutoff`
    → epoch): **4 failed / 9 passed**. The count is wrong in the merchant's
    favour, but two of the report's specific claims are not:
    - *"is one shop's choice and never another's"*, cited as pinning abuse
      case 1, **passes with the permission check removed** — it exercises
      `aiPermissions()`, which is dead code (finding 12), not the gate.
    - *"says how far back it goes, in days"* asserts
      `round((now − retentionCutoff(now))/86400000) === AUDIT_RETENTION_DAYS`,
      which is the definition of `retentionCutoff` restated. It cannot fail for
      any implementation that subtracts days.

---

## What I verified and found sound

Worth recording so the fix round does not re-litigate it.

- **Tenancy.** Every new function calls `shopScope.require`. α cannot remove
  β's sample (reads as not found, no audit row), α's purge leaves β's 2024
  entry, α's permissions are α's. Re-ran the author's boundary tests and they
  are real.
- **The where-clause merge.** The concern that a sibling `createdAt` would be
  clobbered by the cursor's is unfounded: the cursor is nested under
  `AND: [{ OR: [...] }]` (`feed.server.ts:184-193`) and the window is a
  top-level sibling, so Prisma ANDs them. Same for `processedAt` on the order
  side.
- **Page two of a filtered log works.** I drove `loadActivity` with
  `actor: "staff"`, `action: "pricing_rule.created"`, `limit: 2` and the cursor
  from page one: two fresh rows, no overlap, no loss. Order rows inside a date
  window resolve correctly through `processedAt`.
- **`recordedActions()` is not broken by `distinct` + `take: 200`.** I seeded
  250 rows of a late-alphabet action plus one early one; both come back, so
  Prisma is pushing `DISTINCT` to Postgres rather than deduping after the take.
- **The purge self-requeues before it deletes**, and survives a shop with no
  audit rows at all (`deleted: 0`, job still PENDING).
- **No nested forms** on Settings — parsed in Chromium, nine forms, zero inner
  `<form>`, `section=agent` carries no `intent`. Checkboxes go through
  `whenChecked`, so `checked` is absent rather than `"false"`.
- **An empty POST to `section=agent` does turn both off**, and that is right —
  the section form is the only form that posts `section=agent` without an
  `intent`, and an unticked `s-checkbox` posts nothing.
- **i18n is complete**: `_one`/`_other` in EN and all six categories in AR for
  `settings.agent.retention`, `settings.agent.voiceBody` and
  `activity.retention`; all twelve `briefingKind` labels present in both, and
  `briefingMuted` is constrained by `isFactKind` so no raw key can reach the
  page through it.
- **No secrets in the client bundle** (scanned `build/client/`), no PII in
  logs, no `console.log` / `any` / `@ts-ignore` / `.only` / `.skip` in the
  diff, no new console noise in the Playwright log.
- **The audit entry really does carry the label and not the body**, including
  `metadata` (`{ sampleId, characters }`), and the body is React-escaped
  everywhere it renders.
- **Suite re-run from scratch**: `npm test` 2,091 passed / 112 files;
  `npx playwright test` 403 passed; `npm run lint`, `npx tsc --noEmit`,
  `npm run build`, `npm run format:check` all clean. The author's numbers are
  accurate.

## Re-run required

Findings 1–5 change behaviour a merchant sees. After the fix, re-run from step
2 of the QA protocol, and add at minimum:

- an integration or route-level test that **posts** to each ✦ action with the
  permission off and asserts the model was never reached (inject the `AiDeps`
  seam and assert `messages` was not called — the disabled button is not the
  test);
- a test that a shop with `aiMayScreen: false` renders a screening message that
  does **not** mention a key;
- an action-picker test built from `recordedActions()` output rather than a
  hand-written label pair, asserting the labels are distinct;
- `"agent"` added to `SECTIONS` in `tests/e2e/settings-forms.spec.ts`;
- captures for the filtered log, the filtered-empty log, five samples, and the
  brand-voice validation error.

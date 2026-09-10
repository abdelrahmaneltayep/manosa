# QA — 4.5 Home assembled, setup checklist, activity, ✦ Setup Wizard

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

> **Status: clean pass, after a FAIL and a full fix round.** The independent
> cold read was run after this report was first written; it returned **FAIL** on
> three P0s, four P1s and eight P2s. All are fixed or answered — the findings,
> the evidence and what was done about each are in `qa/4.5/COLD-READ.md`, and
> §6 below summarises them. This is the second run.

## 1. Test plan

Spec re-read: `feature-checklist.md` §1 (KPI cards, setup checklist, recent
activity) and `pages-features.md` §1 (the five KPIs, the period selector, the
Claude Setup Wizard); `states-research.md` on CLS and skeletons.

**Happy paths.** A merchant opens Home and sees what their wholesale side did
this month, what they still have to set up, and what happened yesterday. A new
merchant describes their business in three sentences and gets customer groups, a
starter rule and a registration form to look at, then applies them.

**States required by the checklist:**

| Feature   | State                                                  | Capture                  |
| --------- | ------------------------------------------------------ | ------------------------ |
| KPI cards | ideal — five figures, period selector                  | `4.4/15-kpi-cards`       |
| KPI cards | empty — zeros with "waiting for your first order"      | `4.4/17-kpi-empty`       |
| KPI cards | short history — says which days it covers              | `4.4/18-kpi-short-history` |
| KPI cards | partial — "—" and "Needs a week of data"               | `4.4/16-kpi-partial`     |
| KPI cards | edge — delta hidden when the base period is zero       | asserted, no capture     |
| Checklist | in progress, six steps, each deep-linked               | `4.4/19-setup-checklist` |
| Checklist | complete — collapsed to a ✓ pill, with a way back      | `4.4/20-setup-pill`      |
| Checklist | embed attested rather than observed                    | asserted, no capture     |
| Activity  | eight rows, ✦ chip on agent rows, "View all"           | `4.4/21-activity`        |
| Activity  | empty — what will appear here                          | `4.4/22-activity-empty`  |
| Log       | full log, filters, older page                          | `09-activity-log`        |
| Log       | empty, and empty-under-a-filter (different sentences)  | `10-activity-empty`      |
| Log       | Arabic                                                 | `11-activity-arabic`     |
| Wizard    | idle — one question, with an example answer            | `01-wizard-empty`        |
| Wizard    | preview — everything it would create, before it does   | `02-wizard-preview`      |
| Wizard    | applied — what it made, and that the form is a draft   | `03-wizard-applied`      |
| Wizard    | off (no key)                                           | `04-wizard-off`          |
| Wizard    | plan-gated                                             | `05-wizard-plan-locked`  |
| Wizard    | model unreachable → the manual path                    | `06-wizard-timeout`      |
| Wizard    | plan limit reached → what exists, and a way to retry   | `07-wizard-limit`, `12-wizard-partial` |
| Wizard    | audience reach — how many buyers the tag already hits  | `13-wizard-reach`        |
| Wizard    | Arabic                                                 | `08-wizard-arabic`       |

**Three abuse cases I invented:**

1. **A model writing a rule nobody sanity-checked.** 100%, 150%, 0% and −10%
   off; a rule kind of `free_shipping`; an amount of `"$5.00"`; quantity breaks
   that overlap (1–100 then 50+); a form field called
   `social_security_number`; an `audienceTag` of `""`, which is the one that
   matters — a rule aimed at the empty tag is 90% off for everybody.
2. **A hand-edited preview.** The plan travels in a hidden field; posting one
   with no provenance, and one whose contents changed after the preview.
3. **Wrong-tenant reads and writes.** KPIs, the checklist, the feed and the
   wizard's grounding all run in shop α against rows created in shop β; a plan
   applied in β is checked for in α.

## 2. Automated

New:

- `tests/unit/setup-plan.test.ts` — 23, including the round-trip property
- `tests/unit/setup-envelope.test.ts` — 7 (the signed payload)
- `tests/unit/setup-pages-states.test.tsx` — 15 (+13 captures)
- `tests/unit/home-page-states.test.tsx` — 12 added (+8 captures)
- `tests/integration/home-sections.test.ts` — 23
- `tests/integration/setup-wizard.test.ts` — 13
- `tests/integration/storefront.test.ts` — 1 added (the embed stamp)

**Whole suite: 1,715 unit + integration across 92 files, green.**
`npx playwright test`: 313 e2e, green. `npm run lint`, `npm run typecheck`,
`npm run build`, `npm run format:check` clean. No key and no prompt in the
client bundle — grepped after a real build.

Properties worth naming:

- **Two currencies are never added together.** A euro order in a USD shop is
  neither converted nor summed into wholesale revenue.
- **A delta is never divided by zero.** `deltaPercent` returns null for a base
  of zero and for no base at all, asserted in both directions.
- **A checklist step ticks because it happened.** The rule step is false, a rule
  row is created, and it is true — nothing in between opened a page.
- **The embed says which kind of evidence it has.** Attested by the merchant
  reads "your word"; the same shop after a real proxy request does not.
- **Applying is refused with no approver.** `applySetupPlan` with an empty
  approver fails with `MissingApprovalError` inside a `PartialSetupError` that
  names what already exists, and no pricing rule exists afterwards.
- **A plan survives its own round trip.** `read(x)` ok implies
  `read(JSON.parse(JSON.stringify(read(x).value)))` ok and equal — asserted for
  all three rule kinds, for a plan aimed at an existing group, and for a second
  apply. This is the property whose absence made the feature not work.
- **A tampered or unsigned payload is refused.** Including one whose provenance
  was rewritten, which is the path to an audit entry that names a model of the
  attacker's choosing.
- **A wizard-built rule is published.** The apply path calls `metafieldsSet`,
  because a rule that is not published does not exist at checkout.

## 3. States, walked

`npm run qa:capture` renders each state and screenshots it. **Thirteen captures
in this directory** (`01`–`08` wizard, `09`–`11` log, `12` partial apply, `13`
audience reach) and **eight in `qa/4.4/`** (`15`–`22`), where the Home page's
own captures already lived — Home is one page, and splitting its states across
two directories to match task numbers would be worse than the numbering.

**What this proves:** which content and which states render, and that no raw
catalog key reached the page. **What it does not prove:** what a merchant sees.
Polaris `s-*` elements do not upgrade here, so every capture's styling is a
stand-in. No visual pass has happened, here or anywhere. In particular the CLS
claim below is structural — fixed-height tiles in the markup — not measured.

## 4. Boundary

- **KPIs are per shop.** β's £9,990 order leaves α's revenue at zero.
- **The checklist is per shop.** β's live form does not tick α's form step.
- **The feed is per shop.** β's audit rows and orders are invisible in α.
- **The wizard is per shop.** A plan applied in β creates nothing in α, and α's
  grounding does not describe β.
- **The wizard is gated server-side.** A shop without the plan or the key gets
  402 from the action, so posting to `/app/setup` directly cannot reach the
  model.
- **A tampered payload is refused.** The envelope is HMAC-signed with the app
  secret: an edited plan, forged provenance, a payload signed with another
  secret and an unsigned one all decode to nothing and create nothing.

## 5. Invariants

1. **Every price comes from the engine.** Nothing on this page is a price. The
   KPIs are sums of what Shopify already charged, and the wizard's rule is
   constructed as a `PricingRule` and handed to `createRule`, which validates it
   with the engine's own `validateRule` before it is stored or published.
2. **Every query is shop-scoped.** Every new Prisma call is inside the scoped
   client; §4 probes four surfaces.
3. **AI drafts; a person approves.** The wizard's preview is a draft; applying
   is the merchant's click; the audit entry is `aiAssisted` with the approving
   staff member, which `recordAudit` refuses to write without — asserted by
   applying with no approver and watching it throw. The wizard has a timeout,
   one retry and a manual fallback (`askForJson`), and the whole page says so
   and links to the manual path when the key is unset.
4. **Nothing claims to have happened that did not.** The embed row distinguishes
   "we saw your storefront call us" from "you told us"; a metric with under a
   week of history reads "—" rather than a number; a delta with no base is
   absent rather than infinite; the form the wizard creates is a draft and the
   success banner says so.
5. **Deciding shows its working.** Every KPI card links to the page that feeds
   it. The wizard's preview names every group, the rule in one sentence, every
   form field, and its own assumptions — above the button, not folded away.

## 6. Bugs found, and fixed

**From the independent cold read** (full report and evidence in
`qa/4.5/COLD-READ.md`):

1. **The wizard could not apply three ordinary plans.** `readSetupPlan` was not
   idempotent, and the route re-reads the payload before applying — so every
   `amount_off` plan, every plan aimed at a group the shop already had, and
   every second attempt ended at "I couldn't read that answer. Nothing was
   created." The headline feature did not apply. Fixed, and the property the
   author never wrote — read(x) ok ⇒ read(round-trip(x)) ok — is now a test.
2. **Two KPI figures were computed over the wrong column.** `Order.createdAt` is
   when Mannon mirrored the row, and the install backfill imports sixty days at
   once, so "last 7 days" reported up to sixty. `processedAt` now, here and in
   4.4's briefing fact, which had it the same way.
3. **The activity paginator dropped rows.** A timestamp cursor with `lt`, against
   a column whose default is Postgres transaction time — so every audit row
   written in one transaction shares a value and a page boundary inside that
   cluster lost the rest. Composite cursor now.
4. **"Outstanding on terms" disagreed with the page it links to** — it ignored
   refunds, which every other module subtracts. The test now asserts the card
   equals the ledger's own total rather than a number of its own.
5. **The feed showed retail orders** and linked them to a page that filters them
   out.
6. **A part-applied run said "nothing was created"** and destroyed the preview,
   and `RuleValidationError` was uncaught — a 500 on a half-applied shop,
   reachable because the reader accepted a negative amount.
7. **The order count was restricted by currency**, silently undercounting beside
   a briefing that counts the same thing unrestricted.
8. **The audit's provenance came from a merchant-editable field.** It is signed
   now, and verified before apply.
9. Plus: a new group could take an existing group's tag; the preview never said
   how many buyers the audience tag already reached; locked states had no
   `/app/plans` link; `previous` was computed and never rendered; the loading
   state was unreachable; an order with no company rendered a dangling dash.

**Found by the author's own gate:**

1. **A rule aimed at a tag the model invented.** The wizard filtered out groups
   the shop already had, then validated the rule's `audienceTag` against only
   the groups it was still proposing — so a plan that (correctly) reused an
   existing group was rejected outright, and worse, the tag it would have used
   was the model's guess at that group's tag rather than the shop's own. A shop
   that calls a group "Cafés" and tags it `wholesale-cafe` would have got a rule
   priced for `cafes`, which nobody carries: no error, no discount, no clue.
   Existing groups' real tags are now in the grounding and in the allowed set,
   and the rejection message names them so the repair round can fix it.
2. **A JSDoc comment documenting the wrong thing.** A constant added to
   `proxy.server.ts` landed between `withProxy`'s doc comment and `withProxy`.
   Cosmetic, and exactly the sort of thing that makes the next reader trust the
   comments less.
3. **A dead parameter.** `hrefForAudit` selected and accepted `subjectType` and
   never read it.

## 7. Open, not passed

- **No independent cold read on this task** — see the note at the top.
- **No plan has ever been drafted by Claude.** There is no `ANTHROPIC_API_KEY`
  here; `draftSetupPlan` is exercised through its reader, and `applySetupPlan`
  through a plan built by hand.
- **The two new routes' loaders and actions are not driven end to end.** Their
  decisions live in modules that are (`loadKpis`, `loadSetup`, `loadActivity`,
  `readSetupPlan`, `applySetupPlan`); the Remix wiring around them needs a
  Shopify session this environment cannot mint.
- **CLS is structural, not measured.** Fixed-height skeleton tiles are asserted
  in the markup. No Lighthouse run has happened, here or anywhere.
- **No visual pass**, as since 0.1.
- **A wizard run that fails part-way can leave an orphan customer group.**
  Deliberate — groups are created first because a group nothing points at is
  inert — and recorded in `docs/adr/0022`.

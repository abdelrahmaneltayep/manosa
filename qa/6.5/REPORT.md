# QA — 6.5 ✦ Agent controls

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-11 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

> **Status: gate clean. The independent cold read has not run yet.**
>
> Two of the three things this task delivers are not new features. They are
> **behaviour that was already running with no control** (every ✦ surface
> gated on an environment variable a merchant cannot see) and **a promise
> nothing enforced** (the audit log's twelve-month retention, in the schema
> since 0.2 with no job behind it).

## 1. Scope

Checklist §8's agent-controls clause: *"permission toggles (screen / draft /
auto-approve), brand-voice samples manager, per-type briefing mutes, and the
audit log — filterable by actor, action, date; every AI entry links to its
artifact. Retention 12 months."*

Not in it: API keys and translations with the ✦ fill — 6.6, per the split
recorded in `DECISIONS.md`.

**Auto-approve is deliberately not shipped.** Nothing in this app approves an
application without a person, so the toggle would be a control for behaviour
the product does not have — the exact defect 6.4's cold read caught in
`taxExemptNeedsApproval`. `docs/adr/0027` records it.

## 2. Test plan

Spec re-read: `feature-checklist.md` §8, `pages-features.md` §8, `docs/adr/
0027` (written this task), `CLAUDE.md` → Invariants 2, 3, 4 and 5.

**States:**

| Condition | What happens |
| --- | --- |
| Both permissions on | the two toggles, and what neither lets Claude do |
| Screening off | that ✦ surface says *you* switched it off, not "no key" |
| No key at all | the card says the toggles decide nothing either way |
| Samples present | the merchant's own writing, in full, each removable |
| No samples | says what generated copy sounds like without them |
| Five samples | says that is as many as Claude reads |
| A muted briefing kind | listed, with how to undo it |
| Log filtered by actor / action / date | only matching rows, filters kept in the URL |
| Entries older than 12 months | deleted, and the page says how far back it goes |

**Three abuse cases I invented:**

1. **A permission form that omits every checkbox.** Does an empty POST turn
   both permissions off — and is that right?
2. **Removing another shop's writing sample by id.**
3. **A purge run inside the wrong tenant.** Does α's retention delete β's
   history?

## 3. Automated

New: `tests/integration/agent-controls.test.ts` — 13 (the gate, brand voice,
retention, the three filters, both tenants).

**Whole suite: 2,091 unit + integration across 112 files, green.**
**Playwright: 403 passed.** `npm run lint`, `npx tsc --noEmit`, `npm run
build`, `npm run format:check` clean.

### Abuse cases, results

1. **An empty POST turns both off** — and that is correct: an unchecked
   checkbox posts nothing, so "no field" is genuinely "off". Pinned by *"is one
   shop's choice and never another's"*, which posts an empty body and asserts
   both permissions false for α and untouched for β.
2. **Another shop's sample** reads as not found and is not deleted; no audit
   row is written for a delete that deleted nothing.
3. **The purge is shop-scoped** like every other query — α purging leaves β's
   2024 entry alone.

**Watched fail before passing.** Three of the thirteen were re-run against
deliberately broken code (the permission check short-circuited to `false`, the
retention cutoff set to the epoch): 3 failed / 10 passed. A test for a gate
that passes with the gate removed is a test that proves nothing, and this
session has shipped several.

## 4. States walked

The agent-controls states are captured in `qa/6.4/` rather than here, because
they are cards on the **same page** — splitting one page's captures across two
directories would put them beyond `expectDistinct`'s reach, and that guard is
the only thing standing between this repo and a capture set that lies.

13 captures, 13 distinct renders. `15-agent-no-key` is the new one; the
populated agent card is part of `01-settings`, and the guard rejected a second
copy of it under its own name when I tried.

**What this proves:** which content and which states render, and that no raw
i18n key reached the page. **What it does not:** what a merchant sees.

## 5. Boundary

| Attempt | Result |
| --- | --- |
| α reads permissions after β changed theirs | α's own, unchanged |
| α removes β's writing sample by id | not found; β keeps it |
| α purges its audit log | β's 2024 entry survives |
| α lists recorded actions | only α's |

Every function in `app/lib/ai/permissions.server.ts`,
`app/lib/settings/brand-voice.server.ts` and
`app/lib/jobs/handlers/purge-audit.server.ts` calls `shopScope.require(...)`.

## 6. Invariants

1. **Pricing engine.** No price on this page.
2. **Shop scope.** §5.
3. **AI drafts; a person approves.** This task is the invariant made visible.
   The card says in so many words that nothing here lets Claude change a
   price, a customer or an order on its own — and auto-approve is absent
   because the capability is. `aiGate` checks permission before plan before
   key, so a merchant's own choice is never overridden by a deployment
   setting.
4. **Nothing claims to have happened that did not.** The retention line states
   a number a job now enforces; with no key the card says the toggles decide
   nothing rather than implying they do; the action picker offers only actions
   this shop has actually recorded, so it cannot suggest a filter that returns
   nothing. No secrets in the client bundle. **No PII in logs:** a brand-voice
   audit entry carries the sample's *label*, never its body — asserted, not
   assumed, because the body is the merchant's own correspondence.
5. **Deciding shows its working.** `AiGate.blockedBy` names which of the three
   gates is closed, so a ✦ surface can say "you switched this off" rather than
   the blank it used to show.

## 7. Bugs found, and fixed

### The capture guard caught one during the build

`15-agent-controls` rendered identically to `01-settings` — the agent card is
part of the default page, so a capture of it under its own name would have
claimed a state the set does not separately contain. Dropped; the assertions
stayed. This is the third time `expectDistinct` has earned its place.

## 8. What this run does not cover

- **Brand voice is stored but not yet read by any prompt.** The samples are
  kept, shown and removable; wiring them into the drafting prompts is 6.6,
  and until then the card does not claim they are in use — it says what
  generated copy sounds like *without* them.
- **Unmuting a briefing kind** is still done from the home page; Settings
  lists what is muted and says where to undo it. A merchant can now find out
  what they silenced, which they could not before.
- The embedded admin, a real dev store, and Built for Shopify budgets at p75.
- The independent cold read, which has not run yet.

# QA — 4.2 Rule-from-a-sentence, margin guard

Hat: senior QA engineer who did not write this and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

## 1. Test plan

Spec re-read: `feature-checklist.md` §2 (✦ Rule-from-a-sentence, four bullets),
`pages-features.md` §2 (rule-from-a-sentence, margin guard), `brand.md` §5
(dual-mode, temperature 0, ids validated against the live catalogue, the trust
line), `states-research.md` (draft-for-review pattern).

**Happy path.** Sentence → draft card with tier chips, targets, audience and
Claude's own notes → margin guard → Approve & activate → an active rule, an
audit entry naming the approver, and the ruleset republished to checkout.

**States required by the checklist and by `states-research.md`:**

| State | Where it is exercised | Capture |
|---|---|---|
| Composing (empty) | `describe-page-states` | `01-composing` |
| AI down / no key — composer off, builder untouched | same | `02-no-key` |
| Plan limit reached | same | `03-at-rule-limit` |
| Empty sentence | same | `04-empty-sentence` |
| Timeout, rate limit, refusal, invalid output, error | same (`it.each`) | `05-timeout` |
| Draft for review | same | `06-draft-clean` |
| Draft, Arabic RTL | same | `07-draft-arabic` |
| Low confidence — amber chip, "which collection?" | same | `08-clarify` |
| Low confidence, nothing close | same | `09-clarify-no-match` |
| Margin guard clear | same | `10-margin-clear` |
| Margin guard — 3 worst listed, all counted | same | `11-margin-below-cost` |
| Approve anyway not ticked | same | `12-approve-anyway-missing` |
| Margin guard could not run | same | `13-margin-unavailable` |

**Three abuse cases I invented:**

1. **Malformed model output.** Not-an-object, unknown `kind`, an amount as a
   number, an amount with a currency symbol, overlapping tiers, a percentage of
   140, no name, an end date before its start, "next Tuesday" as a date, and an
   answer carrying an extra `sqlToRun` field.
2. **A tampered hidden field.** Garbage JSON, an array, an empty object, a rule
   whose `name` is a number, a payload with the provenance stripped (which would
   forge the audit entry's provenance), and choices whose values are not strings.
3. **Wrong-tenant access by id.** Shop β's customer group id forged into shop α's
   draft envelope as an answer to a chip.

## 2. Automated

New:

- `packages/pricing-engine/test/margin-guard.test.ts` — 19 unit tests
- `tests/unit/rule-from-sentence.test.ts` — 29 unit tests
- `tests/unit/describe-draft.test.ts` — 23 unit tests
- `tests/unit/describe-page-states.test.tsx` — 24 unit tests (+13 captures)
- `tests/integration/margin-guard.test.ts` — 15 integration tests
- `tests/integration/rule-draft.test.ts` — 12 integration tests
- `tests/integration/pricing-rules.test.ts` — 4 added

**Whole suite: 1,340 unit + integration across 71 files, green.**
`npx playwright test`: 244 e2e, green. `npm run lint`, `npm run typecheck`,
`npm run build`, `npm run format:check`: clean.

Two properties worth naming, because they are the ones that would rot quietly:

- **`builderFields` → `parseRuleForm` → the same rule.** "Edit in the builder"
  posts the draft as the builder's own field names; the test parses them back
  and compares the engine rule, including in a three-decimal currency.
- **The prompt contains no ids.** Asserted on the real request body, not on the
  prompt template.

## 3. States, walked

`npm run qa:capture` renders each state and screenshots it into this directory.
Thirteen states, both languages for the draft card.

**What this proves:** which content and which states render, and that no raw
`describe.*` catalog key reached the page (the guard now covers that root).
**What it does not prove:** what a merchant sees. Polaris `s-*` elements do not
upgrade in this environment — no egress to `cdn.shopify.com` — so the styling in
every capture is a stand-in. No visual pass has happened, here or anywhere.

## 4. Boundary

- **Cross-tenant by id.** Shop β's group id, forged into shop α's envelope,
  resolves to nothing: `groupIds` comes back empty, the chip stays unanswered,
  and the id appears nowhere in the prepared rule. Not an error, not a leak — it
  reads as a term this shop cannot place, which is exactly the invariant.
- **Grounding is shop-scoped.** `loadGrounding` in shop α lists α's groups only.
- **Every resolved id comes from this shop's grounding.** `resolveDraft` cannot
  emit an id it was not given, so there is no path from a model answer or a
  tampered field to another shop's row.
- **The approve path re-derives everything** from the envelope inside the
  request, under the shop scope: it never trusts the page's account of what the
  rule was.

## 5. Invariants

1. **Every price comes from the engine.** The guard prices through
   `resolvePrice`; the card shows no price of its own. `formatCurrency` formats
   what the engine returned.
2. **Every query is shop-scoped.** Groups, tags, rules, audit and the rule limit
   all read through the scoped client. Cross-tenant probes fail closed (§4).
3. **AI drafts; a person approves.** The only write is `approve`, through
   `createRule` with `SaveProvenance` whose `approvedById` is required by the
   type. `recordAudit` refuses an `aiAssisted` entry without one — and, as of
   this task, the rule and its entry commit in one transaction (bug 1 below).
   The call has a timeout, one retry, and the manual builder is reachable from
   every failure state.
4. **Nothing claims to have happened that did not.** A guard that could not read
   the catalogue says so and does not ask for a tick; a sampled check says it
   sampled; variants with no recorded cost are counted, not passed. No secrets
   in the client bundle (`tests/unit/ai-bundle.test.ts` still green), and the
   run log holds no merchant text — asserted.
5. **Deciding shows its working.** The card lists every tier as its own chip,
   names its targets and audience, prints Claude's own assumptions verbatim, and
   the guard names the SKU, the quantity, the price and the cost.

No unhandled rejections in the e2e logs. One deliberate `console.error` in the
guard's Admin-API failure path, exercised by a test.

## 6. Bugs found, and fixed

1. **`createRule` could leave a live rule with no audit entry.** The insert and
   `recordAudit` were separate awaits, so a refused AI-assisted entry — the one
   the invariant exists to produce — left an active pricing rule nobody was
   recorded as approving. Now one interactive transaction; the test asserts the
   rule count is zero after the refusal.
2. **`.env.example` had drifted from `shopify.app.toml`** — missing
   `write_orders` since 3.1. Fixed while adding `read_inventory`.
3. **The i18n capture guard did not cover the `describe.` root**, so a raw key
   on this page would have gone unnoticed. Added.
4. Two test-harness bugs of my own, found by the suite and by `tsc`: a fixture
   that dropped its overrides (making twenty assertions vacuous), and a helper
   typed as the engine's `Targeting` when it carries the model's name-shaped
   JSON. Both fixed; `vitest` does not typecheck, `npm run typecheck` does.

## 7. Open, not passed

- **No call has ever been made to Anthropic.** There is no `ANTHROPIC_API_KEY`
  here. Every path is driven through an injected `MessagesApi`. The request
  shape — model, temperature 0, cached system block, no ids in the prompt — is
  pinned; the response is a stub.
- **No cost has ever been read from a real store.** `inventoryItem.unitCost`
  needs `read_inventory`, added to the scopes this phase, and a dev-store
  session that does not exist here. The query shape and the minor-unit
  conversion are pinned against a fake admin, including a three-decimal
  currency.
- **No visual pass.** As above, and as since 0.1.
- **Streaming is not implemented.** `DECISIONS.md`, 2026-09-10 — a stated
  difference from the checklist, not an oversight.

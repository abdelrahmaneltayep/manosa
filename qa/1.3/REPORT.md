# QA report — 1.3 · Pricing page: rule list, builder, priority and combinations


**Verdict: pass with open items.** Rules are stored, edited, ordered, explained
and published to checkout, and every state in checklist §2 is rendered and
asserted. Four deviations are deliberate and argued in ADR 0008; three gaps are
listed in §7.

### 1. Test plan

_Happy paths_

- Create, edit, archive, restore and permanently delete a rule.
- A saved rule reaches checkout; an archived one leaves it.
- Reordering rewrites priority in the order the merchant left.
- "Why this price?" runs the real engine over the real rules.

_States (checklist §2)_

- Rule list: empty, partial (no filter bar under three), ideal, no search
  results, cached, publish failed, at the plan's quota, archived-empty,
  paginated, and the badge set — missing targets, schedule countdown, duplicate
  name, unused, ended.
- Builder: new, field-level validation, overlapping tiers, live preview,
  preview unavailable, save conflict, duplicate-name warning.
- Settings: order with the combination warning, explain with reasons, explain
  with no matching rules, explain clamped at zero.
- Arabic for the list and the builder.

_Three invented abuse cases_

1. **Malformed input** — a rule with a blank name, a percentage of 150,
   overlapping tiers, an unparseable money amount, and a permanent delete whose
   typed confirmation does not match the rule's name.
2. **Concurrency** — two staff editing one rule: the second save is refused with
   the other person's version attached, and the row is unchanged.
3. **Wrong shop/tenant** — listing, fetching by id and archiving another shop's
   rule.

### 2. Automated tests

`npm test` — **383 passed** (26 files), up from 337. This task adds 46:

| Suite                                      | Cases | Covers                                                                                                                                                                                                          |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/pricing-rules.test.ts`  | 22    | Create/edit/archive/restore/delete, publish-on-save, database round trip, validation, plan quota, version conflict and forced overwrite, list ordering/search/pagination, reorder, three tenant-isolation cases |
| `tests/unit/pricing-pages-states.test.tsx` | 24    | Every §2 state above, in English and Arabic                                                                                                                                                                     |

Lint, typecheck and build clean.

### 3. State walkthrough

Twenty-three states captured to `qa/1.3/` (`npm run qa:capture`), covering the
list, the builder and the settings page in both languages.

Same caveat as 0.3, restated because it matters: these verify **which content
and which states render**. They are not a design review — Polaris cannot load
here, so the styling is a stand-in, and each capture says so.

### 4. Cross-tenant check

Three cases in the integration suite: another shop's rules are absent from the
list and from the engine ruleset, a fetch by id returns null, and an archive
attempt raises 404 while leaving the row untouched. The edit route's loader
turns that null into a 404, so the HTTP-level cross-tenant check carried since
0.1 is now closed.

### 5. The three musts

| Rule                                           | Status at 1.3                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No price from outside the pricing engine       | **Held, and now visible.** The live preview and "Why this price?" both call `resolvePrice`; the trace shown to the merchant is the engine's own. Saving publishes the same rules to checkout. There is no second pricing path. |
| No AI mutation without an approval record      | Unchanged. "✦ Describe a rule" is rendered but disabled, pointing at 4.2, rather than absent — the merchant should know it is coming.                                                                                          |
| No unhandled promise rejections in the e2e run | Unchanged and clean.                                                                                                                                                                                                           |

### 6. Bugs found and fixed

1. **`disabled={false}` renders as `disabled="false"`.** React stringifies props
   on custom elements, and a browser reads any present `disabled` attribute as
   disabled — so "Create rule" would have been permanently unclickable for every
   merchant not at their quota. Found by reading the rendered markup in a
   capture. Fixed with a helper that omits the attribute instead of setting it
   false, and every `s-*` boolean prop now goes through it.

2. **Rows leaked between integration tests.** `resetDatabase` had a
   hand-maintained table list that did not include `PricingRule`, so eleven
   unrelated assertions failed at once. Fixed by deriving the list from the
   Prisma DMMF — the same principle as the tenant guard: no registration step to
   forget.

3. **English plurals, again.** `missingTargets`, `startsIn`, `endsIn`,
   `unreadableHeading`, three target counts, three audience counts and
   `liveHeading` were all written as a bare key plus `_other`. The plural test
   from 0.3 caught all eleven before they shipped, which is the second time that
   test has paid for itself.

A fourth issue was in a test rather than the code: the pagination fixture had one
row but claimed a hundred and twenty, so it asserted "51–51 of 120" against a
correct "51–100 of 120". Fixed the fixture.

### 7. Open items

- **Market scoping is not offered in the builder.** The Function cannot evaluate
  it (ADR 0007) and the country-to-market map needs a Shopify Markets query that
  cannot be verified without a store. Withholding the control is the honest
  choice: a merchant cannot build a rule that the admin shows applying and
  checkout ignores. The engine and storage already support it.
- **Targets and audiences are typed as ids, not picked.** A merchant pasting
  product GIDs is not shippable UX; the fix is App Bridge's resource picker,
  which cannot be exercised outside the admin iframe. This is the largest
  remaining usability gap on the page and should be closed in the dev-store
  session.
- **The live preview updates on save, not per keystroke.** The checklist asks for
  300 ms. The engine is browser-safe, so this is a client-side wiring job rather
  than a design problem, but it is not done.
- **Usage counts are `null` until 6.1.** Rendered as an em dash with a
  screen-reader explanation, never as a zero — "not measured" and "zero" are
  different facts.
- **Unchanged and still blocking Phase 1:** the dev-store run from 1.2. Nothing
  in this task has been seen in the Shopify admin.

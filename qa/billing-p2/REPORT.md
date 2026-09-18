# QA — billing cold read, the P2s

Date: 2026-09-18
Scope: #2, #3, #4, #5, #7 from `qa/0.3/COLD-READ.md`.
(#1 — a red `typecheck` — and #6 — `snapshotFrom`'s comment — were closed by
earlier rounds. Re-checked: `npx tsc --noEmit` is clean and `snapshotFrom` no
longer exists.)

Each fix was verified by reverting it and watching its own probe fail for the
reason the finding gives.

---

## #2 — `entitlementsFor` failed open

**The finding.** `status === "PAST_DUE" && graceEndsAt !== null && graceEndsAt
<= now`. A `PAST_DUE` row whose `graceEndsAt` is null was never lapsed —
unbounded paid access. Both writers set it today; a gate should not depend on
that.

**The fix.** The absence of a grace window reads as expired, not as an
indefinite pass. It is the only answer that can cost us money rather than give
a plan away.

**Probe** (`tests/unit/entitlements.test.ts`, +1): a `PAST_DUE` shop on Agentic
with `graceEndsAt: null` falls back to Free, still remembering Agentic.
**Reverted:** `expected 'agentic' to be 'free'`.

## #3 — `SHOPIFY_BILLING_TEST_MODE` had no production guard and no per-shop notion

**The finding.** `assertEnvironment` did not look at it. Set `true` on a
production deployment and every merchant subscribes for free behind a polite
"no money changes hands" banner; set `false` and a development store cannot
subscribe at all, surfacing as the generic "We couldn't start that change".
`README:277` told an operator to set it per store, which one multi-tenant
deployment cannot do.

**The fix.** Both halves.

*Per shop.* Shopify already knows: `shop.plan.partnerDevelopment`, read with
the rest of the shop's facts and stored as `Shop.isDevelopmentStore`
(migration `20260918220000_development_store`). `testModeFor()` returns true
for those stores whatever the environment says. A response that does not carry
the field writes nothing — `null` is not `false`, and guessing "real store"
puts a live charge on one Shopify will decline.

*Per deployment.* The variable survives as an override for working against a
store that is not a dev store, and `assertEnvironment` throws
`BillingTestModeInProduction` before anything else when a production process
has it set. The message names what breaks and what makes the variable
unnecessary.

`syncSubscription` also reads the shop record **before** `billing.check` rather
than after: the check filters by test mode, so asking with the wrong one
returns an empty list for a shop that does have a subscription — which this
module reads as "they cancelled".

**Probes** (`tests/unit/billing-test-mode.test.ts`, new, 9; `shop-facts`, +3):

| Probe | Result |
| --- | --- |
| a development store gets a test charge with nothing configured | pass |
| a real store gets a live charge | pass |
| a shop with no record yet gets a live charge | pass |
| the variable still forces test mode on a non-dev store | pass |
| anything but the exact string `"true"` is off | pass |
| a production process in test mode refuses to start | pass |
| …and says which variable, what it costs, and what replaces it | pass |
| development is left alone | pass |
| `partnerDevelopment` true / false / absent → true / false / null | pass |

**Reverted** (dev-store branch removed): 1 failed. **Reverted** (boot guard
disabled): 2 failed.

README and `.env.example` now say what is true.

## #4 — orphan i18n keys

**The finding.** Eight keys in both catalogues that nothing renders; the parity
test compares the catalogues only with each other, so it cannot see them.

**The fix.** `tests/unit/i18n-orphans.test.ts` makes the English catalogue a
**total map**: every key is either rendered by something in `app/`, or named in
`WRITTEN_AHEAD` with the reason it is still there. The scan errs towards
over-counting uses — any string literal that looks like a key counts, and a
template literal marks its whole prefix — because a missed orphan costs a dead
string and a false alarm would fail the build over copy that ships.

**What it found.** Thirty-seven, not eight.

*Deleted (13)* — superseded, another key does the job today: the six the cold
read named, plus `plans.usage.pricingRules`/`forms` (duplicated by
`limit.pricingRules`/`forms`), `locked.heading`/`body`/`cta` (superseded by
`agent.locked.*` and `po.locked.*`), `pricing.list.edit`, and
`pricing.list.delete` with the six `pricing.deleteModal.*` keys — a pricing
rule is archived, never deleted, and the list offers Archive and Restore.

*Kept and named (24)* — copy written before its control. Deleting the words
would hide the gap rather than close it, so each entry says what is missing:
the rule builder has **no way to add or remove a tier** and **no
unsaved-changes guard** (CLAUDE.md requires one), no resource picker, no
preview switchers; the list has no sort control; the conflict banner has no
side-by-side; the CSV page has no dropzone; the error boundary does not read
the catalogue. Three further tests keep that list honest: an entry whose
control gets built fails, an entry naming a key that no longer exists fails,
and an entry with a blank reason fails.

**Probe.** The guard is the probe: it failed on 13 keys before they were
deleted, which is how each was found.

## #5 — count-bearing plan strings interpolated without `count`

**The finding.** `plans.usage.ofLimit`, `nearingBody`, `atBody`,
`change.limitTightens` and `change.overageBody` all pass `used` / `limit` /
`overBy` under their own names, so Arabic renders ungrammatically for 1, 2 and
3–10.

**The fix**, and the reading behind it (`DECISIONS.md`, dated today): a string
is count-bearing when its **own words** change with the number, not merely
because a number appears in it.

- `usage.ofLimit` is left alone and the reason written down. "4 of 5" inflects
  nothing in either language, and the row's label names the item.
- `usage.atBody`, `usage.nearingBody` and `change.limitTightens` had a bare
  number standing where a noun belongs — "The Free plan allows 1" — which
  cannot be made to agree in Arabic, because a numeral alone has nothing to
  agree with. They interpolate the existing `limit.<key>Allowance` phrases,
  which already carry all six Arabic categories and the right gender per item.
  "The Free plan allows 1 pricing rule."
- `change.overageBody` is the one whose own words change: "It stays saved"
  against "They stay saved". Pluralised on `count: overBy`, with `_one` and
  `_other` in English and all six categories in Arabic, written so the
  agreement is with the count and never with the item's gender.

**Probes** (`tests/unit/plans-page-states.test.tsx`, +1 state, +5 assertions):
"allows 1 pricing rule", "8 of 10 pricing rules", "1 pricing rule allowed, 14
in use", "13 pricing rules more than Free allows" with "They stay saved", and a
new one-over state asserting "It stays saved" **and** the absence of "They stay
saved".

**Reverted** (`count` dropped from the call): 2 failed — and the paragraph
vanished entirely rather than degrading, which is the defect CLAUDE.md names.

## #7 — the quote expiry job mailed buyers on a lapsed shop

**The finding.** `expire-quotes.server.ts` sends reminders with no
`draft_orders` check, so a lapsed shop keeps emailing buyers about a paused
feature.

**The fix.** The two halves of that job are not the same act, so they are not
gated together. **Expiring still runs on every plan**: a quote past its date
must never read as live on a page the merchant can still open, and expiring
only ever takes a promise away. **Reminding is gated**: quotes are paused on
Free, the merchant could not honour a reply, and the app would be chasing
somebody on behalf of a feature it has switched off.

`remindedAt` is deliberately **not** stamped when a reminder is withheld —
it means "we told them", and we did not — so a merchant who resubscribes before
the quote runs out still gets the reminder they paid for. The count is returned
and audited as `remindersPaused`, so the run does not report a silent zero.

**Probe** (`tests/integration/quotes.test.ts`, +1): two quotes out with buyers,
the subscription cancelled mid-flight. One expires, no mail is written,
`remindedAt` stays null, and resubscribing sends the reminder.
**Reverted:** `expected { expired: 1, reminded: 1 } to match { reminded: 0 }`.

---

## Invariants

1. **Every price from the engine** — untouched.
2. **Shop scoping** — `billingTestMode()` goes through `shopScope.require`;
   `Shop.isDevelopmentStore` is read and written through the scoped client.
3. **AI drafts, a person approves** — untouched.
4. **Nothing claims to have happened that did not** — #7 is exactly this on the
   buyer's side, and #3's boot guard stops a deployment telling merchants they
   are paying when nobody is charged. `remindersPaused` keeps the job's own
   report honest.
5. **Deciding shows its working** — #2: a lapse now has one rule deciding it
   rather than two writers agreeing by habit.

## Suite

`npx vitest run` — **137 files, 2409 tests, all passing.**
`npm run lint` clean, `npx tsc --noEmit` clean, `npx prettier --check .` clean.

## What this round does not prove

`shop.plan.partnerDevelopment` is read from the Admin API, which is unreachable
from this environment: the field name and its type come from the schema, and
the parsing is tested against fixtures, but nobody has seen a real response. A
wrong field name would be a silent `null`, which writes nothing and leaves the
stored answer alone — the safe failure, and the reason the parser refuses to
read an absent field as `false`.

The Arabic plural forms are written from the CLDR categories and the shape of
the existing catalogue, not reviewed by an Arabic speaker.

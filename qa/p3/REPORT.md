# QA — the P3s

Date: 2026-09-19
Scope: every finding filed as **P3** across the thirteen cold reads in `qa/`.

---

## What was open, and what was already closed

The P3 band exists in four cold reads — 6.2, 6.3, 6.4 and 6.5. (5.3 numbers its
findings `P1`–`P17` with severity words beside them, so its "P3" is an index,
not a band; it is closed — the publish panel reads `storefrontSeenAt` and
`embedConfirmedAt` and says so when neither is set. 0.1, 0.3 and 1.1-1.2 have
no P3s at all.)

Each was re-derived from the current source rather than taken from the
PROGRESS line claiming it fixed. **Twenty-three of twenty-seven were genuinely
closed:**

| Cold read | P3s | Verified closed |
| --- | --- | --- |
| 6.2 | F-14 loading skeleton · F-15 two tests that could not fail · F-16 duplicate captures · F-17 no query ceiling | all four — `AnalyticsPage` has a `Skeleton`, both tests now assert the window they set up, `MAX_ORDERS = 5_000` with `ordersCapped`, and the lines are fetched once |
| 6.3 | P3-17 … P3-22 | all six — `topGroup` dropped, quiet-month chips suppressed, `previewNotYet` fires only on a form with no id, `usableZone` catches a bad IANA name, the diff reads the currency stored on the row, the charts load once |
| 6.4 | eight | seven — hex day counts, markup in an email, `?saved=` faking a confirmation, the audit over-count, `section=danger` bypassing the confirm, double-pause moving the date, and the dead Settings link |
| 6.5 | 17 … 25 | six — the `MAX_SAMPLES` race, 365 days vs twelve months, `mutedUndo`'s copy, the silently truncated label, `?&before=`, and the miscounted "watched fail" |

Four were open. They are the subject of this round.

---

## 6.4 P3-5 — a setting and the entry that says who changed it were two awaits

**The finding.** `settings.server.ts:193-201` writes `shop.update` and then
`recordAudit`, "and pause/resume the same. The repo's known latent shape; no AI
path reaches it."

**Why it is worth fixing anyway.** Everything on this page is a decision a
merchant can be asked about later — which tag is the wholesale tag, whether
Mannon's prices combine with a discount code, what a buyer is told when an
order is too small. A change with no entry beside it is indistinguishable from
a change nobody made, which is invariant 5 on the page that decides what the
app does. The same is true, more sharply, of the pause flag: a paused app with
no record of who paused it is the single most consequential control on the page,
silently flipped.

**The fix.** `saveSettings` and the pause half of `pauseApp` each take their
write and their audit entry in one `db.$transaction`, passing the transaction
to `recordAudit` — which has always accepted one.

**What was deliberately left alone.** `resumeApp`'s two writes are separated by
the publish to Shopify, and the entry says how many rules went live — a number
that does not exist until the publish has. Holding a database transaction open
across a network call is the worse trade, and the compensating action already
there (re-pause if the publish fails) is what keeps that pair honest. Said in
the code rather than left to be rediscovered.

**Probes** (`tests/integration/settings-atomicity.test.ts`, new, 3): the audit
write is made to fail, because that is the half the old order left exposed —
the setting had already landed.

| Probe | Result |
| --- | --- |
| a saved setting and its entry land together | pass |
| a setting that cannot be recorded is not saved | pass |
| a shop that cannot be recorded as paused is not paused | pass |

**Reverted** (both transactions unwound back into sequential awaits): 2 failed —
`expected 'trade' to be 'wholesale'` and `expected 2026-09-18T15:55:52.784Z to
be null`.

## 6.5 #22 — an inverted date range showed an empty log and said nothing

**The finding.** A `from` later than its `to` yields zero rows "with no hint the
dates are backwards".

**The fix.** `rangeIsInverted(from, to)` in `feed.server.ts`, surfaced twice: as
an `error` on the `to` field — *"This date is before the one you started
from."* — and as the empty state's own sentence, *"Nothing matches, because the
dates are the wrong way round. Swap them and try again."* Zero rows is the
answer either way; only this tells a merchant which zero they are looking at.
A range with one end open is not inverted — it is open — and a half-typed date
reads as no date at all, because `readDay` refuses a partial.

**Probes** (`tests/unit/activity-range.test.ts`, new, 5 · one new captured
state): inverted, right-way-round, same day at both ends, either end open, and
a partial date. The state test asserts both sentences render and that the
ordinary "Nothing of this kind yet" does not.

## 6.5 #24 — the one form on Settings with no unsaved-changes guard

**The finding.** "Only the section form carries `data-save-bar`; a pasted email
is lost on navigation."

**The fix.** The add-sample form carries it too. This is the form a merchant
pastes a real email into — up to 4,000 characters of something they wrote to a
buyer — and CLAUDE.md asks every form to guard unsaved changes.

It is a *sibling* of the section form, not nested inside it: `Section` renders
it through its `after` slot, which exists precisely because 6.4's P0 was a
nested `<form>` whose start tag the parser drops. The probe asserts the opening
tag immediately before `value="addSample"` carries the attribute, rather than
counting occurrences on the page — a count would pass on the wrong form.

**Reverted:** `expected '<form method="post"><input type="hidd…' to contain
'data-save-bar'`.

## 6.5 #23 — two migrations, the second undoing the first

**Not fixable, and here is why.** `migrate deploy` checks each migration file
against the checksum in `_prisma_migrations`, so editing an applied migration —
even to add a comment — fails the deploy on every environment that has already
run it. Deleting one is stop condition #3. So the SQL is untouched.

`prisma/migrations/README.md` carries the explanation instead: no deployment
ever ran `20260911123138_agent_controls` without `20260911123310_agent_controls_two`
(one commit), no shop has ever had `Shop.aiMayAutoApprove`, and the reason it
was removed rather than left switched off is invariant 3 — auto-approval is an
AI write path that changes customers with no person in it. Written for the
reader who finds the column in a `git log` and goes looking for the feature.

---

## Invariants

1. **Every price from the engine** — untouched; nothing here computes a price.
2. **Shop scoping** — both new transactions run inside `shopScope`, and
   `recordAudit` stamps `tenant()` on the transaction client exactly as on the
   base one. `tests/integration/tenant-relations.test.ts` and the settings
   isolation tests still pass.
3. **AI drafts, a person approves** — reinforced by the migrations note, which
   records *why* the auto-approve column was removed.
4. **Nothing claims to have happened that did not** — 6.5 #22 is this
   invariant exactly: an empty log claiming "nothing of this kind yet" about a
   question that could not have matched anything.
5. **Deciding shows its working** — 6.4 P3-5 is this one: a setting changed
   with no entry naming who changed it.

## Suite

`npx vitest run` — **140 files, 2484 tests, all passing.**
`npm run lint` clean, `npx tsc --noEmit` clean, `npx prettier --check .` clean.

## What this round does not prove

**The save bar is still unverifiable here.** `data-save-bar` is read by App
Bridge, which never loads in this environment. What is proven is that the
attribute is on the right form and that the form is not nested inside another;
what a merchant sees when they navigate away is not.

**One line is untested.** The activity loader's
`rangeInverted: rangeIsInverted(from, to)` is the wiring between a tested
predicate and a tested render, and nothing covers it — driving an embedded
route loader needs a Shopify session this environment cannot produce. Reverting
that line to `false` leaves the whole suite green. It is named here rather than
covered by a source-grep test pretending to be a behaviour test.

**`settings-atomicity.test.ts` is the first file in this repo to use
`vi.mock`.** The failure it injects is real (the audit insert throws) but it is
injected, not provoked: nothing in the schema lets a test make that insert fail
on its own.

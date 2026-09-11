# Cold read — 6.6 Translations

Reviewer: an independent QA pass that did not write the code, run against
commit `2ecabba`. **Verdict: FAIL** — four P0s, five P1s, nine P2s.

This is the tenth consecutive cold read to return FAIL after my own seven-step
gate passed. The findings and what was done about them are below; the tests
that prove each one live in `tests/integration/translations-regressions.test.tsx`,
which failed eleven times against `2ecabba`.

## P0-1 — One shop's wording overwrote the shipped catalogue, process-wide

`instance.addResource(...)` writes **into the object it is handed**, and this
process handed it the imported `en.json`. So the moment any shop saved a string
and any page rendered, the shipped catalogue itself was rewritten — for every
later request, for every other tenant, **outbound to their buyers**.

Also poisoned, in the same stroke: `shippedString()` (so every other shop's
"Mannon ships: …" column, the source the placeholder validator compares
against, and the English an ✦ fill hands Claude), and "leave this empty to go
back to Mannon's own words", which came back to the deleted wording.

My own tenancy test missed it because it never built an instance inside the
first shop's scope before reading in the second. Invariant 2, and the worst
kind of breach of it: outbound.

**Fixed.** Overrides are their own i18next namespace (`shop`), built fresh per
instance, looked up first and falling through to `common` per key — so nothing
is ever written into the shipped catalogue, and overriding `expiresIn_one`
leaves Arabic's other five plural categories alone. `getFixedT` binds to that
namespace; binding to `common` is how a `t` skips every override.

## P0-2 — The wording reached one of the five surfaces the page names

ADR 0028 claimed "exactly one place an instance is made per request". There
were three, and two passed no overrides: `entry.server.tsx` (every React page)
and `entry.client.tsx` (the whole client). So the registration form and the
public quote — the two pages this feature exists for — rendered Mannon's words.
The public quote failed twice over: its loader built `t` **before** entering the
shop's scope, so even the server-side `t` saw no overrides.

**Fixed.** `ShopWording` (`app/components/i18n/ShopWording.tsx`) provides an
instance over the buyer-facing subtree from overrides the route's loader
returned — the only component that can, since `/f/:publicId` identifies its
shop from a row only the loader has read. The same loader data reaches the
server render and the hydration, so the two agree; a buyer watching the
merchant's wording flip back to Mannon's on hydration would be worse than never
seeing it. `q.$publicId` now builds `t` inside the scope, and a test asserts the
ordering in the source because the failure is silent.

## P0-3 — `BUYER_FACING_ROOTS` was mostly admin copy, and the Limits link was a dead end

Every `limit.*` key is the Plans page's allowance copy; all 31 `approval.*` keys
are the merchant's own criteria builder; most of `forms.*` and `quotes.*` is the
admin. 534 strings offered, about forty of which a buyer ever reads — and
editing any of the others changed nothing anywhere. Worse, the Limits page's
"Change this wording" link, added in this task under the checkout-message
preview, landed on 23 rows none of which was that message: it lives in
`packages/order-limits`' `DEFAULT_MESSAGES` and was not editable at all.

**Fixed.** `BUYER_FACING_PATHS` — `forms.public`, `quotes.public`,
`agent.scripted`, `checkout` — about fifty strings, every one of which a buyer
reads. The checkout messages are now catalogue keys; `messageTemplates()`
resolves each from the merchant's wording in the shop's own language, read
straight off the row rather than through `t()` (i18next handed `{{gap}}` with
no value would mangle the two numbers that make the message worth reading), and
the route re-publishes the metafield when one changes — otherwise the table
would show new wording while every buyer read the old.

`tests/unit/buyer-strings.test.ts` now reads the buyer-facing source files and
fails if any key they translate is missing from the set. The list is checked
against the surfaces rather than believed.

## P0-4 — ✦ wording went live before anyone read it

`overridesFor` selected every row with no `needsReview` filter, so a suggestion
was on the buyer's page on the very next render — under a badge reading "Claude
suggested this", beneath a promise that "nothing reaches a buyer as your words
until you accept it", against a checklist line that says "never auto-publish a
language the merchant hasn't seen". Invariant 3, in the plainest possible way.

**Fixed.** `overridesFor` takes `needsReview: false` only. The fill records the
model and prompt version (so 6.5's audit filter can find the one ✦ path that
changes what buyers read) and is deliberately *not* `aiAssisted`: it is a draft.
`acceptString` is the entry that carries `aiAssisted` **and** the approver,
which is what `recordAudit`'s missing-approval guard is for.

## P1s

- **"Only ones with no wording at all" could never return a row** — both
  catalogues ship complete, so `shipped` was always truthy and the filter always
  produced the empty state. The fifth inert control in this repo, and the one my
  own note about computing the count on a fresh install exists to catch. It now
  means "only ones you haven't written yourself", which is what the ✦ panel
  beside it counts.
- **Accepting a suggestion recorded no approver** and was a write in a *loader*,
  triggered by `?accept=` — so a prefetch or a link scanner performed it. It is
  a POST now, carrying the session, and it rides on the page's own Save.
- **No save bar, and per-row POSTs discarded the other rows.** On a page built
  for bulk editing, typing into five rows and pressing Save on one threw four
  away silently. One form now, `data-save-bar`, with each row carrying what it
  said when the page was drawn so untouched rows stay untouched.
- **Arabic was only two-sixths editable** — `editableKeys()` walked English
  only, so Arabic's extra plural categories were refused as "not a string a
  merchant can change". It now walks both.
- **Every capture was of rows the route cannot emit** — `forms.submit`,
  `quotes.expiresIn` and `approval.welcome` do not exist in the catalogue. The
  fixture failure this repo has now had four times, and the raw-key guard could
  not see it: those elements are the ones carrying `data-string-key`. The
  fixtures use real keys, and a test now reads the fixture file and checks every
  key in it against `editableKeys()`.

## P2s acted on

- **The ✦ fill was not plan-gated** (`aiGate("draft")` with no feature can never
  answer "plan"), so a whole locked state was unreachable and a free shop could
  spend a model call. Now gated, with a test that posts on a free plan.
- **`requiredPlan` was the raw `PlanKey`** — "This needs the pro plan". Fixed
  here and on the two analytics pages carrying the same defect.
- **Fill failures rendered the Buyer Agent's copy** — "so the agent can't
  answer", "Nothing was sent", on a page where neither happened.
- **The guard exemption swallowed whatever text was inside the element.** It now
  exempts only text equal to the key the element declares, so a real fallback
  cannot hide behind an opt-out on the one page where it would look at home.

## P2s not acted on, deliberately

- No length cap on a single saved string (the import file is capped at 2 MB).
- `buildView` calls `unwrittenIn` on every page load for its `.length`.
- No concurrency control on a save: two staff on one key is last-write-wins.

All three are real and none changes what a merchant is told. They are recorded
in `PROGRESS.md` rather than fixed in a round already this large.

## Also found clean by the reviewer

Prisma-level shop scoping (the leak was above the database, not in it) ·
`StorefrontString` correctly named in the uninstall purge · the
prototype-pollution import case · audit metadata carrying keys and counts but
never words · `readTranslations` dropping unasked keys and placeholder-breaking
replies · `requireAi` enforced on the POST (the 6.5 lesson held) · no secrets in
`build/client`, verified against a real build.

One correction to my own report: `qa/6.6/REPORT.md` said "0 skipped". The
client-bundle guard is `it.runIf(built)` and there was no `build/client` when I
ran it, so that check did not run in my pass. The reviewer built and ran it:
clean. The report is corrected.

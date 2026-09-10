# Decisions

Judgment calls made without stopping to ask, one dated paragraph each: what was
chosen, why, and what was rejected. Newest first.

The long-form reasoning for architectural choices lives in `docs/adr/`; this
file is the running log, including the small calls that never earned an ADR.

---

## 2026-09-10 — Screening compares the website, and never fetches it

Checklist §3 says "Checking website & VAT". The VAT half is real (VIES, from
2.2). The website half compares the domain the applicant typed to the domain
they email from, and makes no request: fetching an address a stranger supplied,
from our server, is the shape of every SSRF, and this environment has no egress
to arbitrary hosts anyway. The comparison is a real signal at no risk, and the
copy says what was actually checked. Rejected: a fetch behind an allowlist
(a list of what, exactly?) and a headless render (worse, and slower).

## 2026-09-10 — A screening verdict is codes, not prose

Claude picks up to three signals from a closed list of nineteen and a verdict;
the sentence a merchant reads is ours, from the catalogue, in their language.
Rejected: free-text reasons, which read better in English and cannot be
translated, cannot be audited against a fact, and let a model write a sentence
about a real business that the merchant then acts on. The cost is that Claude
cannot say something we did not anticipate — which is the same thing as the
benefit.

## 2026-09-10 — A saved segment is a filter; a rule's audience is a snapshot

Segments store conditions, not people, so they stay true as the customers
change. But `Audience` in the pricing engine has no "segment" mode, and adding
one would mean publishing each buyer's segment membership to checkout the way
tags and groups are published — a phase of its own. So applying a segment to a
rule fills the audience with the customer ids matching _now_, and the rule says
when the snapshot was taken. Flagged as user-visible: a merchant may expect a
segment-backed rule to follow the segment. Rejected: silently live-looking
behaviour, and blocking the feature until membership publishing exists.

## 2026-09-10 — Conditions are ANDed, with no nesting

"Spend over $5k · quiet 45 days" is what a merchant means and what fits in a row
of chips. An OR nested three deep is a query builder, and a query builder is the
thing ✦ Segments exists to avoid. A merchant who needs one saves two segments.
Rejected: a full boolean tree (unreadable as chips, and unbuildable without
JavaScript on a props-only page).

## 2026-09-10 — The ✦ composer does not stream, and the margin guard is not AI

Checklist §2 lists "streaming draft (tiers appear as chips one by one)" as a
state. It does not ship. Streaming into the admin needs client JavaScript in a
page family that is deliberately props-only — every admin screen is a pure
function of its view, which is the only reason any of their states can be
exercised in an environment with no Polaris and no Shopify session. Adding a
live channel to one page would cost that, to animate an answer that arrives in
a few seconds anyway. `streamText` stays for the agents (4.4, 5.x), where the
transport is already a live channel. Flagged as a user-visible difference: a
merchant sees a working state, not chips appearing one at a time.

Separately, `margin_guard` was removed from `AI_FEATURES`. The guard is
arithmetic over real prices and real costs — `guardMargins` in the pricing
engine — and appendix B says the model never computes what a module can. The
closed list of AI features stays honest about where Claude is actually asked
something. Rejected: an AI "second opinion" on the numbers, which would be a
verdict a merchant cannot audit.

## 2026-09-10 — The draft card is ✦ and indigo, not terracotta

`feature-checklist.md` §2 says the draft-for-review card has a "terracotta
border", and `states-research.md` says "terracotta ✦ accent". `brand.md` §2
lists the whole palette — indigo primary, lime accent only, "never a large
fill" — and has no terracotta in it. A spec contradiction; the brand document
wins on colour, and Polaris web components expose tones rather than arbitrary
borders, so a custom border would mean custom CSS that app review rejects. The
draft is marked the way brand.md §5 asks: the ✦ glyph, an info-toned card, and
the trust line verbatim in spirit — "✦ Drafted by Claude · review it before it
goes live. You approve it, not the AI."

## 2026-09-10 — Claude drafts targeting by collection, never by product

The model may target `all` or `collections`. Products and variants are targeted
by id, and a 10,000-product catalogue cannot be put in a prompt to pick from —
so a sentence naming specific products drafts against everything and says so in
its notes, and the merchant narrows it in the builder with the draft filled in.
Rejected: a product search step before drafting (two round trips before the
merchant sees anything), and letting the model name products for a fuzzy title
match (a wrong match prices the wrong product at the right discount, which is
the failure nobody notices).

## 2026-09-10 — Rule-from-a-sentence is not plan-gated

No `FeatureKey` gates it. The free plan's one-rule limit already decides what
can be approved, and the composer says so before drafting rather than after.
Rejected: gating it behind Growth like `merchant_agent` — the spec puts
rule-from-a-sentence in the Pricing page's own feature list, and a merchant who
cannot try the thing the product is sold on will not buy the plan that unlocks
it.

## 2026-09-10 — The draft lives in a hidden field, not in a table

A merchant either approves a draft or leaves. Persisting every abandoned one
means a retention policy, a cleanup job and a second place a half-made rule can
be found. Everything in the envelope is re-read defensively and re-derived on
every round trip, including the approve, so it carries no more authority than
the builder's own form fields. Rejected: a `RuleDraft` table (a migration and a
retention job for something nobody asked to keep) and a signed cookie (same
storage question, smaller ceiling).

## 2026-09-10 — The model stays `claude-sonnet-4-5`, behind one setting (flagged)

`CLAUDE.md` and the spec name `claude-sonnet-4-5`. It is a previous-generation
id — the current equivalent is `claude-sonnet-5`, and `claude-opus-5` is the
more capable default — but the spec names a model explicitly and silently
upgrading a merchant's model is not a call to make on their behalf. It ships as
the documented default of `MANNON_AI_MODEL`, so moving is one environment
variable and no code. **Flagged for the user:** if the spec's id is simply older
than the spec, say so and it changes in one line.

## 2026-09-10 — Nothing in `app/lib/ai/*` can write to the database

The wrapper returns text. Turning that into a change is the feature's job, and
`recordAudit` already refuses an `aiAssisted` entry with no approver. Keeping
the model's output and the write path in different modules is what makes "AI
drafts, a person approves" a property of the architecture rather than of nine
features remembering. Rejected: helpers that apply a suggestion directly.

## 2026-09-10 — `askForJson` repairs once, then gives up

A validator the caller supplies, one repair attempt carrying the error back, and
then the manual path. At most two model calls. Rejected: repairing until it
parses (a merchant paying for a loop), and returning a value that failed the
caller's own check (a half-valid pricing rule is what invariant 1 exists to stop).

## 2026-09-10 — The AI run log stores no prompt and no completion

Feature, model, prompt version, token counts, latency, and the provider's error.
Not the text either way — it carries the merchant's product data and their
buyers' names, and "what has this been doing" and "what is it costing me" are
both answerable without it. Rejected: storing prompts for debugging, which is
how a support tool becomes a data-protection problem.

## 2026-09-10 — Thinking and effort are not configured centrally

They are model-dependent: `budget_tokens` on Sonnet 4.5, adaptive on the current
generation, and `effort` errors on the older one. The wrapper sends neither, so
it works on whichever model `MANNON_AI_MODEL` names; a feature that knows its
model can opt in. Rejected: hardcoding one generation's shape into the one place
every feature goes through.

## 2026-09-10 — Quick order is on the Pro plan (flagged assumption)

The spec's plan ladder does not place the storefront quick-order tools. They sit
on Pro ($29) with CSV import and auto-tagging, because they are a wholesale
convenience rather than a premium capability like net terms or an agent — a free
store with one pricing rule has no use for a bulk SKU form. Rejected: Growth
($59), which would put a basic ordering aid behind the terms tier. **Flagged:**
move it with a one-line change in `plans.ts` if that reading is wrong.

## 2026-09-10 — The variants table uses one form per row, not one for the table

A single form posts every variant, including the ones left at zero, and
Shopify's `/cart/add` refuses a line of zero. Per-row forms mean every row works
with JavaScript off, and "add all" becomes the script's contribution — hidden
until the script is there to make it work. Rejected: one form plus a JS filter,
which would have made the no-JS path silently broken.

## 2026-09-10 — Quick order says it needs JavaScript; the variants table does not

They degrade differently because they are different. There is no SKU lookup
without a request, so quick order shows a note and a catalogue link — the
checklist's own fallback — rather than a form that cannot submit. The variants
table has everything it needs in the theme's own render, so it works entirely
without a script and the price shown in advance is the enhancement.

## 2026-09-10 — The variants block sends list prices as minor units

Liquid's `variant.price` is already an integer in the currency's subunit, so it
goes to the app as-is. A decimal round-trip would be wrong in every three-decimal
currency — the bug 3.2 shipped. Rejected: sending a decimal string for
consistency with Shopify's Admin API, which uses one.

## 2026-09-10 — Theme blocks are tested through a Liquid stand-in

`tests/support/liquid-stand-in.ts` renders enough Liquid to get a block into
Chromium, so the JavaScript that actually ships can be driven against a stubbed
proxy. It is not a Liquid implementation and does not prove Shopify renders the
markup identically — but the script is the part that can break, and it was
untested otherwise. Rejected: shipping the blocks with no browser coverage at
all, and pulling in a real Liquid engine for a test harness.

## 2026-09-10 — A quote's accept link is a random token, not a cuid

Registration forms use `@default(cuid())` for their public id. A quote's link
reveals one buyer's negotiated prices and lets somebody act on them, so it is 24
random bytes instead. Rejected: reusing the cuid default for consistency —
consistency is not worth a guessable link to somebody's contract pricing.

## 2026-09-10 — Price drift is shown on a quote, never applied

Once a quote is locked the detail page re-runs the engine for display only, and
marks any line the store would now price differently. A merchant honouring a
fortnight-old quote wants to know; they do not want the app to change it under
them. Rejected: silently re-pricing (breaks the promise), and hiding the
difference (leaves a merchant unable to tell a good quote from a bad one).

## 2026-09-10 — A sent quote cannot be re-priced

The state machine allows `draft` from NEW and DRAFTED, not from SENT. A merchant
who wants to change a quote already with a buyer withdraws it and starts again.
Rejected: allowing a silent re-price, which would let a buyer accept one price
and be charged another.

## 2026-09-10 — The expiry job re-queues itself instead of running daily forever

There is no recurring scheduler here. `quotes.expire` schedules its own next run
just after midnight while any quote is still out, and stops when none is.
Rejected: a fixed daily job per shop (a no-op forever on stores that never
quote), and expiring on read (a quote nobody opens would never expire).

## 2026-09-10 — Quote state lives in `app/lib/quotes/`, not a fourth package

The pricing engine, order limits and net terms are packages because a Shopify
Function needs them. Nothing about quotes runs in a Function, so the state
machine is a pure module inside the app instead. Rejected: a fourth package for
symmetry, which would add a workspace for no portability gain.

## 2026-09-10 — The terms Function fails closed; the limits Function fails open

Both must never throw, but "safe" means opposite things. An unreadable order
limit is dropped and the order goes through, because the harm there is blocking
a legitimate sale. An error in the terms Function hides the pay-later method,
because the harm here is a buyer taking goods on credit nobody agreed to.
Rejected: one house rule for both, which would have got one of them wrong.

## 2026-09-10 — `publishBuyerFacts` requires `terms`, it does not default it

Making the field optional meant every existing caller published `null`, which
reads as "this buyer has no terms" — silently withdrawing credit a merchant had
granted, from five call sites that had no idea they were doing it. Making it
required turned that into a compile error and found all five. Rejected: a
default of `null`, and a default that re-reads the buyer (a hidden query inside
a publisher).

## 2026-09-10 — A buyer's terms replace their group's; they never merge

Net 60 from the buyer with the tier's £500 credit limit is a third arrangement
nobody wrote down. Whichever level sets `days` supplies the limit too. Rejected:
field-by-field merging, which is what the obvious implementation does.

## 2026-09-10 — Payments are append-only rows, and overpayment is refused

A correction is another row, negative if it has to be, so the ledger can be
explained line by line. An amount over the balance is almost always a typo — two
digits, or the wrong invoice — and a ledger that absorbs one quietly stops
reconciling. Rejected: editing the previous payment, and clamping silently.

## 2026-09-10 — A third pure package rather than growing either existing one

`packages/net-terms` is its own module. Terms are not prices and not limits:
they answer "may this buyer owe us money", which is a question about history
rather than about a cart. Rejected: folding aging into `order-limits` (unrelated),
and into the pricing engine (which stays small so "every price comes from one
module" remains checkable).

## 2026-09-10 — The checkout preview shows a term this store actually uses

The pay-later button preview was going to read "Pay later (Net 30)" for every
merchant. A store whose buyers are all on Net 60 would have been shown a preview
of a button none of them will ever see, so it takes the days from a real group
or buyer, falling back to 30 only when nothing is set.

## 2026-09-10 — `orders/edited` flags the row rather than rewriting it

The order-edited webhook carries a diff of line items with no totals in it.
Flagging the row and showing a resync badge keeps a total we know is honest but
stale; the `orders/updated` that follows the edit carries the whole order and
clears the flag. Rejected: recomputing the total from the additions and
removals, which would make this app's arithmetic the source of a number Shopify
owns.

## 2026-09-10 — Whether an order is wholesale is decided once, on arrival

Read from the buyer as they were at the time, then never re-decided. Approving
someone for wholesale today must not silently move last month's orders into the
wholesale revenue figure. Rejected: recomputing on every update, which is what
the obvious implementation does.

## 2026-09-10 — Order limits are scoped by country, not by market

The validation Function is handed `localization.country.isoCode` directly.
Scoping by market would need a `markets` query, a stored mapping and a way to
keep it current, for a distinction merchants usually express as a country
anyway. Rejected: markets — additive later if anyone asks. `docs/adr/0014`.

## 2026-09-10 — A second pure package rather than growing the pricing engine

`packages/order-limits` is its own module. Limits are not prices: they answer a
yes/no with a gap, they never touch a rule, and the pricing engine staying
small is what keeps "every price comes from one module" checkable. It imports
`@mannon/pricing-engine` for `Money` and nothing else. Rejected: a `limits`
directory inside the engine.

## 2026-09-10 — The orders list stops at 60 days, and says so on the page

`read_orders` reaches 60 days; `read_all_orders` is a review-time grant this app
does not have. The list carries a line stating the window rather than presenting
a partial history as the whole of it. Rejected: requesting `read_all_orders` now
(a review conversation for a feature nobody has asked for), and saying nothing.

## 2026-09-10 — Historical orders are mirrored but not tagged

The backfill writes no tags into Shopify. Putting a wholesale tag onto hundreds
of a merchant's existing orders on install is a lot of noise in their admin for
something they never asked for. New orders are tagged once, on arrival, and
never re-tagged — a merchant who removed the tag meant to.

## 2026-09-10 — The shop's Shopify GID is read and cached, not assembled

Found while writing `publishLimits`: the shop metafield's `ownerId` was being
built from our own Prisma row id, which Shopify would never resolve. The GID is
read once from `shop { id }` and cached on the Shop row. Rejected: querying it
on every publish.

## 2026-09-10 — `increment_below_two` renamed to `increment_too_small`

The i18n catalog test caught it: a key ending in `_two` is read by i18next as an
Arabic plural suffix, so the catalogs failed to validate. Renamed at the source
in `packages/order-limits` rather than worked around in the catalogs. A reminder
that machine-readable codes end up as translation keys.

## 2026-09-10 — Specs checked into the repo

The four spec documents were only ever attachments in a chat. `CLAUDE.md` now
names them as the source of truth, so they are checked in at `docs/spec/`
verbatim. Rejected: paraphrasing them into the repo, which would have created a
second version to drift from the first.

## 2026-09-09 — Applications land in a job, not in the buyer's request

Auto-approval is several Admin API calls. Running them inline would make a
buyer wait on Shopify, and — worse — a failure would happen while the
application was half-decided. It runs in `forms.decide_applications`, which
stamps each application before deciding it so one that always throws is looked
at once instead of blocking the queue behind it. Rejected: inline evaluation,
and a fire-and-forget promise (which loses the failure). `docs/adr/0013`.

## 2026-09-09 — Undo does not delete the Shopify customer

Undoing an approval takes back the tags, the tier and the wholesale status, but
leaves the customer account it created. Deleting a customer is destructive and
irreversible; a stray account nobody has used costs the merchant nothing. The
audit entry says one was left behind so the record is not misleading. Rejected:
deleting it (irreversible on a ten-second timer) and hiding the fact (a lie in
the log).

## 2026-09-09 — Resend over HTTP, not an SMTP library

Notification email needed a transport. Resend's API is one POST, so the
transport is fifty lines and no dependency; `MANNON_EMAIL_TRANSPORT=log` covers
development. Rejected: nodemailer (a dependency and an SMTP config surface for
one POST) and leaving the seam empty (the feature would have been undeliverable
in principle, not just unconfigured).

## 2026-09-09 — The theme block frames the form rather than re-rendering it

A Liquid copy of the registration form would be a second implementation of the
code that decides whether an application is accepted. The alternative —
publishing the definition to a metafield and looping over it in Liquid —
depends on how app-reserved metafields are exposed to theme app extensions,
which cannot be verified without a store and cannot be looked up (shopify.dev
is unreachable here). Framing the app's own page keeps one renderer and works
with scripts off. Cost: the form does not inherit theme typography, which is
what the Appearance tab is for. `docs/adr/0012`.

## 2026-09-09 — Auto-tagging has no schedule

The engine and the preview are built; nothing runs on its own. A background
process that re-prices a customer base with nobody watching should not exist
before the reporting that would explain it. The merchant presses "Apply to
customers" and sees the result. Rejected: a nightly sweep. `docs/adr/0011`.

## 2026-09-09 — Customers are mirrored, not queried per request

The buyers list needs filters, sorting and real pagination that
`customers(query:)` cannot serve, on a rate limit shared with pricing and
publishing. A `Customer` row per Shopify customer, kept current by webhooks and
seeded by a backfill job. Shopify stays the source of truth: every write goes
there first, and tags go through `tagsAdd`/`tagsRemove` so another app's tags
survive. `docs/adr/0010`.

## 2026-09-09 — A deleted customer keeps their row

`customers/delete` flags the mirror row rather than removing it. Deleting it
would drop a row out of an open list mid-scroll, change a group's member count
under the merchant, and lose the history behind a tier. Retention removes it in
7.2. `docs/adr/0010`.

## 2026-09-09 — CSV import is planned before it is run

An import is dry-run first, and the dry run checks the _published_ size so an
import cannot half-land at checkout. Undo removes exactly what it created, for
an hour. The uploaded bytes are held server-side between the two steps because
a browser will not resubmit a file input. Rejected: importing straight through
with a per-row error report afterwards. `docs/adr/0009`.

## 2026-09-08 — Market scoping is withheld from the rule builder

The engine and the storage support market-scoped rules; the builder does not
offer them, because the country-to-market map needs a Shopify Markets query
that cannot be verified without a store. The alternative was a control that
shows a rule applying which checkout would ignore — the exact disagreement this
app exists to prevent.

## 2026-09-08 — Checkout reads a published ruleset from a metafield

A Shopify Function cannot call our API and its input query is fixed at deploy
time, so the ruleset travels as data. The Function computes nothing: it calls
`@mannon/pricing-engine`, the same module the admin calls. Saving a rule
publishes. `docs/adr/0007`.

## 2026-09-08 — Money is integer minor units, and currency is never converted

An absolute-money rule in a currency the store does not price in is skipped,
not converted at a rate we invented. `docs/adr/0006`.

## 2026-09-07 — Building the suite, not the brand document's product

`brand.md` describes a narrower quote → counter → accept → reorder tool that
"never rebuilds tax, totals, or checkout". The other three specs describe a
wholesale-pricing suite, including a discount Function that prices at checkout.
The build follows the three. Flagged rather than resolved silently, and still
worth a word from the user if the brand document is the newer thinking.

## 2026-09-07 — PostgreSQL in development too

The prompt allowed SQLite in dev. Rejected: the tenant guard, the JSON columns
and `String[]` all behave differently, so a dev database that is not Postgres
tests a different application. `docs/adr/0001`.

## 2026-09-07 — i18next wired directly, not through `remix-i18next`

`remix-i18next`'s Remix-2 release pins i18next 23; this app is on 26. A fresh
instance per server request, so two shops rendering in different languages
cannot race. `docs/adr/0003`.

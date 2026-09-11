# Decisions

Judgment calls made without stopping to ask, one dated paragraph each: what was
chosen, why, and what was rejected. Newest first.

The long-form reasoning for architectural choices lives in `docs/adr/`; this
file is the running log, including the small calls that never earned an ADR.

---

## 2026-09-11 — A spec contradiction: retention vs the approval record

CLAUDE.md stop condition 6 asks for both lines quoted and one picked. 6.5
shipped this resolved silently in the wrong direction; the cold read found it.

`feature-checklist.md` §8: _"the audit log — … **Retention 12 months**."_
`CLAUDE.md` Invariant 3: _"No AI write path may change live pricing, customers
or orders without a merchant approval **recorded in `AuditLog`**."_

They conflict for exactly one kind of row. After twelve months, a pricing rule
Claude drafted and a merchant approved is still pricing every checkout, and
the only record that anybody approved it has been deleted.

**Invariant 3 wins.** `purgeAudit` now exempts `aiAssisted: true` rows.
Retention is a storage promise about volume; the approval is the record that
makes the whole AI story auditable, and it is a handful of rows per shop per
year. The page says twelve months about everything else, which is what a
merchant reading it is asking about.

Rejected: purging them and keeping a redacted stub — a stub that says an
approval happened without saying who approved it is worse than either
alternative, because it looks like a record. Also rejected: making the
exemption configurable; a merchant cannot meaningfully consent to losing the
audit trail of a decision they made.

## 2026-09-11 — No API keys page until there is an API

§8 asks for "public API keys, webhooks, ERP sync, POS toggle". A read of the
routes says there is no public API to key: the 53 routes are the embedded
admin, the App Proxy, two public-by-design pages (the registration form and
the quote accept link), Shopify's inbound webhook endpoint, a bearer-token
internal job runner, and a health check.

So a keys page would hand a merchant a credential that authenticates nothing —
they could create it, copy it, paste it into their ERP, and get 404 on every
call. That is the third time this shape has come up: `taxExemptNeedsApproval`
in 6.4 (shipped, caught by the cold read, removed) and the auto-approve toggle
in 6.5 (not shipped, for this reason). It is the worst of the three, because a
credential implies a contract.

Deferred, with the dependency named: a read API is its own task — auth,
scopes, rate limits, versioning, pagination, and a documented shape — and the
keys page comes after it. Recorded here and in `PROGRESS.md` so it is deferred
rather than forgotten.

Rejected: shipping the page against the App Proxy's existing signature scheme.
That is Shopify's signature over Shopify's request, not a credential a
merchant's own systems can present.

## 2026-09-11 — Two agent permissions, not the checklist's three

§8 asks for screen / draft / **auto-approve**. The first two gate behaviour
this app has; the third gates behaviour it does not — there is no path in the
product that approves an application without a person. 6.4 shipped a toggle
for an imaginary tax-exemption flow and the cold read caught it, so: two
toggles now, the third with auto-approval itself, defaulting off.

Rejected: shipping it disabled "so the default is recorded" — a default is
already recorded by the column, and a switch that does nothing is a claim the
product cannot keep. `docs/adr/0027`.

## 2026-09-11 — Settings part two is agent controls; API keys and translations move to 6.6

The earlier split put API keys, translations and agent controls together in
6.5. Reading the code showed agent controls alone is a full task: three
permission columns threaded through fifteen call sites, a brand-voice model, a
briefing-mute view, three new audit-log filters, and the twelve-month
retention job that the schema has promised since 0.2 with nothing behind it.

So 6.5 is agent controls, 6.6 is API keys and translations, 6.7 is polish.
Same reasoning as splitting §8 in the first place: a task whose QA gate cannot
walk its own states is a task that has not been scoped.

## 2026-09-11 — Settings is two tasks, and polish moves to 6.6

Checklist §8 asks for eight areas — display, discount combinations, tax,
notifications with email-domain verification, translations with a ✦ fill, API
keys, agent controls with the audit log, and a danger zone. That is not one
task, and pretending it is would mean a QA gate that walks a tenth of the
states it claims.

Split: **6.4** takes the merchant's own settings (the section shell and save
bar, display, discount combinations with the "affects 3 active rules" warning,
tax, notifications and email-domain verification, danger zone) and brings the
settings already scattered across other pages — wholesale tag, order tag, POS
bypass, terms method, quote expiry — into one place. **6.5** takes the
technical and ✦ half (API keys, translations with the AI fill, agent controls:
permission toggles, brand-voice samples, briefing mutes, the filtered audit
log). Polish and orders-over-time become **6.6**.

Rejected: one giant 6.4, and dropping the ✦ half into 7.x — the agent
permission toggles are the one place a merchant can say what Claude may do on
its own, and shipping the agents without it would leave Invariant 3 resting
entirely on code nobody can see.

## 2026-09-11 — A capture that renders like another is a capture of nothing

Two captures in one set that produce identical markup were, six times across
five milestones, one page under two names — and every test passed, because
each asserted against the page they shared. Rather than re-checking by eye,
`expectDistinct` in the capture harness fails the second one and names the
first. It runs whether or not `QA_CAPTURE` is set, so CI catches it.

Rejected: comparing screenshots after the fact (too late, and it would have
needed a byte-comparison step nobody would keep), and allowing an opt-out for
"sections of the same page" — that opt-out is exactly the door the six
duplicates came through. A section worth a capture is worth props that differ.

## 2026-09-11 — `Order.totalPrice` is already net of refunds, and there is now one place that says so

The cold read on 6.2 found `totalPrice - refundedAmount` in seven places across
three milestones — analytics, the Home KPI card, the orders view model, the
net-terms ledger and `toInvoice`. `totalPrice` is written from Shopify's
`current_total_price`, which already has the refund taken off, so every one of
them removed it twice. On the ledger that meant showing a merchant **less**
owed than they were, on the one screen whose job is chasing money.
`app/lib/orders/totals.ts` is now the single definition: `orderRevenue` is
`totalPrice`, `amountOwed` is `totalPrice - amountPaid`, and a gross figure — if
one is ever wanted — is `totalPrice + refundedAmount`, not the other way round.
Three tests that had encoded the bug were rewritten from the writer's own
output first, and watched go red.

## 2026-09-11 — Orders-over-time is deferred; AOV is not

`pages-features.md` §7 asks for "Wholesale vs. retail revenue, **AOV**, orders
over time". `feature-checklist.md` §7 — the file `CLAUDE.md` names as settling
required states — lists neither. Per stop condition 6, both lines are quoted
here rather than silently picked between.

AOV is one division away from figures already on the page and is now a stat
line under the revenue chart — a single current value is a stat, not a one-bar
chart. An order-count series is a different measure on a different scale, so it
is a **second chart**, never a second axis on the revenue one; it is deferred to
6.5 rather than bolted on during a fix round, and recorded in `PROGRESS.md` so
it is not lost.

## 2026-09-11 — The analytics page is not plan-gated

`feature-checklist.md` §7 lists the charts, the CSV exports and the aging report
under parity features, not under a paid tier, and `FEATURE_KEYS` has no
`analytics` entry. So the page is available on every plan, including free. The
reasoning that settled it: a merchant cannot decide whether to pay for wholesale
features without being able to see what their wholesale is doing. The two ✦
analytics features in 6.3 gate on `merchant_agent`, like every other Merchant
Agent surface. I wrote the gating first and removed it rather than leaving two
dead view fields behind — dead view data was a cold-read finding on 5.3.

## 2026-09-11 — Chart colour is chosen against a validator, not a token

Polaris tokens dress the card, the type and the rules around a chart; the marks
themselves take a separate, validated palette — which is why Shopify ships
Polaris Viz rather than colouring charts from UI tokens. Every set was run
through the six checks against `#ffffff` and `#1a1a1a`; the first ordered ramp I
tried failed the adjacent-lightness check and was re-stepped rather than argued
with. Only one chart is categorical (wholesale vs retail); the nominal charts
are one colour each, because shading bars darker-where-bigger encodes the bar's
length twice. Recorded in `qa/6.2/REPORT.md` §5 with the measured numbers.

## 2026-09-10 — A merchant's reply is delivered, not just recorded

5.3's cold read found that "Take over" wrote a reply the buyer could never see,
under a widget string promising they would. Three options: deliver it by a
signed proxy GET the widget polls, deliver it by email, or stop promising.
Chose the first. Email is a worse fit for a live chat the buyer is sitting in
front of, and telling the truth alone would leave the checklist's "hands live
chat to merchant" unmet. Polling starts **only** after a person joins, so a
conversation nobody took over still costs the storefront one request per turn —
the rule the whole widget is built on, and now asserted by a test that counts
GETs.

## 2026-09-10 — The capture guard derives its catalogue roots

`CATALOG_ROOTS` was a hand-written list, and forgetting an entry switches the
raw-key guard off for a whole page family silently. That has now happened twice
(4.2's `describe`, 5.3's `agent`). It is derived from the English catalogue's
own top-level keys. Rejected: adding `agent` and moving on, which fixes this
instance and leaves the third one waiting.

## 2026-09-10 — Analytics is split in two, and Settings moves to 6.4

`PROGRESS.md` had "6.1–6.3 Analytics, Settings, polish", which was my own
shorthand and not a spec. Analytics as one task is six charts, their states,
CSV per chart, **and** two ✦ AI features — and it turned out to need a data
model that does not exist yet. So: **6.1** mirrors order lines (the foundation
four of the six charts need), **6.2** is the Analytics page and its charts,
**6.3** is ✦ ask-your-data and the ✦ monthly review, **6.4** is Settings, and
**6.5** is polish. Nothing is dropped; the numbering moved.

## 2026-09-10 — A rule's performance is read from the name the buyer saw

There is one automatic discount per shop, so the discount cannot say which rule
fired. The Function already sets the winning rule's name as the line's discount
message, and Shopify reports it back on the order — so rule performance groups
by that name. The consequence is deliberate: a renamed rule does not rewrite
what it earned last quarter, because the name on the line is the name the buyer
was actually shown. Rejected: adding a per-rule discount (Shopify caps automatic
discounts, and a merchant with forty rules would hit it), and writing our own
rule id into a note attribute at checkout (the Function cannot write one, and a
cart attribute is buyer-editable). `docs/adr/0024`.

## 2026-09-10 — Test mode rehearses against a real buyer and writes nothing

Checklist §6 asks for a merchant who "chats as a simulated buyer (pick any real
buyer's context)". So a rehearsal is an ordinary conversation with `testMode`
set: the same tools, the same rules, the same prices, and the two tools that
write — `request_quote` and `escalate` — skipped and _said out loud_ in the
reply rather than silently no-oped. An unpublished agent answers in test mode,
because rehearsing before publishing is the entire point of the fourth
pre-publish item. Rejected: a simulated buyer built from made-up attributes (it
proves nothing about the prices this agent will actually quote), and letting the
writes happen "because it is only a test" (a panel that quietly files a real
quote request teaches the merchant it is safe to press right up until the day it
is not).

## 2026-09-10 — A finished conversation is closed, never deleted or back-dated

"Start a fresh test" needed some way to stop `openConversation` continuing the
existing thread. Adding `AgentConversation.closedAt` was chosen over the two
alternatives: deleting the old rehearsal (it is evidence the merchant may want
to read back after changing a guardrail, and deleting it would untick the
publish checklist), and moving `lastMessageAt` outside the idle window (a lie in
a column, and the log would then misreport when the conversation happened).

## 2026-09-10 — "Guardrails reviewed" is the merchant's word, with a timestamp

Three of the four pre-publish items are answered by a query, the way the setup
checklist answers its six. The fourth cannot be: no query knows whether somebody
read a page. So `reviewedAt` records the merchant saying they did, from a button
that is deliberately separate from Save — a box that ticks itself whenever
somebody presses Save is answering a different question. Rejected: inferring it
from a page view (a checklist that ticks itself off when you look at a screen is
a checklist that lies), and dropping the item (it is the one thing on the list
that is about the merchant having made a decision rather than about the shop
having data).

## 2026-09-10 — The Buyer Agent's reply may only repeat figures the engine computed

Checklist §6 asks for it twice — "the agent can never invent a price", "prices
only from published rules (test asserts this)". A prompt cannot enforce that, so
the tool runs first, its computed figures are kept, and the reply is scanned for
money and refused if it states any that is not in that list. The scanner reads
symbols, ISO codes, bare decimals and percentages, and deliberately treats a
bare integer as _not_ money — "100 units" and "boxes of 24" have to stay
sayable, and a check that flagged them would be switched off within a week.
Comparison is on the number, not the formatting. Rejected: asking the model
nicely (the failure is silent and the merchant is liable), templated sentences
(a concierge that cannot form a sentence is not one, and this ships in Arabic
too), and re-pricing what the model said afterwards (it says things that are not
prices). `docs/adr/0023`.

## 2026-09-10 — Two model calls per turn, not one with tool definitions

Route the question to a tool, run the tool ourselves, then write the reply. The
obvious alternative — one call with tool definitions, letting the model drive —
is fewer tokens and one fewer round trip, and it puts the model between the
price and the buyer with nothing in between. Splitting it is what makes room for
the figure check, and it means an unpublished agent or a switched-off ability
costs nothing to refuse. Rejected: the single agentic call, and streaming (the
answer is a database read; there is nothing to stream).

## 2026-09-10 — A guardrail is a missing code path, not a sentence in the prompt

Switching off "may file a quote request" removes the tool from the list the
model is offered _and_ is re-checked inside `runTool` before the work. So the
agent has no path to a quote, rather than an instruction not to take one. The
merchant's own free-text instructions are advisory and bounded, and
`lintInstructions` warns when they read as though they could grant something —
"offer discounts freely", "negotiate", "place the order for them" — because a
merchant who believes their agent is doing that is worse off than one who is
told it will not. It warns rather than blocks: the text cannot do the thing
anyway, so refusing to save it would be theatre.

## 2026-09-10 — Six setup steps, and the sixth is choosing a plan

The spec names four (embed, first rule, form, first approved buyer); the
checklist says the card persists until **6/6**. The two extra are the ones a
merchant actually does next: taking a first wholesale order, and choosing a
plan. Both are queries, like the other four, so neither can tick without having
happened — and "choose a plan" links to the plans page rather than nagging,
because staying free is a decision a merchant is allowed to make. Rejected:
padding the list with steps that tick on a page visit, and shipping four of six
with a card that never completes.

## 2026-09-10 — The KPI period lives in the URL, and deltas hide rather than lie

`/app?period=7|30|90`. A query parameter rather than a stored preference: it is
shareable, it survives a reload, it needs no client JavaScript, and it is one
fewer column on `Shop`. Two figures carry a comparison (revenue and order
count); the other three are counts of what is true right now, and an arrow
beside "4 live pricing rules" would be comparing today's count with one nobody
took. A delta is hidden whenever the base period is zero — "▲ ∞%" is not a
number, and "▲ 400%" off one order last week is a worse one. Under a week of
history, the period cards read "—" with "Needs a week of data" rather than
printing arithmetic on noise.

## 2026-09-10 — The activity feed is a union of two tables, paged on time

Everything a person or an agent did is in `AuditLog`; orders are mirrored from
Shopify and are not audited, because nobody in this app did them. So the feed
reads both and merges on time, and pages by timestamp cursor rather than by
offset — an offset into a merge is not a position in either table. Rejected:
writing audit rows for orders (a log of things this app did not do), and an
orderless activity feed (the checklist names orders first).

## 2026-09-10 — The Ask bar does not stream, and its examples do not rotate

Checklist §1 asks for "Streaming: inline result panel under the bar; Esc
cancels" and "rotating placeholder examples (3, localized)". The inline result
panel exists and the destructive-intent rule on the same line is what the
routing enforces; the streaming does not. An answer is one database read that
returns in milliseconds, so there is no stream to watch and no long-running
request for Esc to abort. The three examples render under the bar and the first
is the field's placeholder; rotation needs a client-side timer, which is the
same reason as ⌘J below. Rejected: a streaming endpoint for a sub-second query,
and rotating server-side per request (the examples would change under a
merchant mid-sentence, on every unrelated post).

## 2026-09-10 — Muting a briefing item asks first, and the list lives on Home

"Not this again" is a link to `/app?confirm=<kind>`, which asks the question;
only the "Stop showing it" button posts. So nothing is written by a click, a
reload cannot re-mute, and the confirm needs no client JavaScript. The list of
muted kinds — with an unmute beside each — renders under the briefing rather
than in Settings, where checklist §1 puts it: Settings is 6.2, and a one-way
door with no visible way back was the worse of the two. Both directions are
audited. Rejected: a POST to open the confirm (a write for a question), and
waiting for 6.2 (the mute shipped in 4.4; the way back has to ship with it).

## 2026-09-10 — The buyer picker lists a hundred, and says so

A `s-select` cannot paginate, so PO-to-order lists the hundred largest buyers.
The bug that made this worth writing down: the chosen buyer was resolved out of
that same capped list, so a shop with more buyers than the cap priced a
purchase order as though nobody was buying it — silently, at list price. The
selected buyer is now fetched by id whenever the list does not hold them, the
page says the list is not everybody, and `?buyerId=` gives a way in from the
customers list, which does paginate. Rejected: raising the cap (moves the
cliff), and a search box (a JavaScript-free typeahead is a bigger feature than
the one it would serve).

## 2026-09-10 — The briefing may not write a number, and the reader enforces it

`readBriefing` refuses any reason containing a digit. The app renders its own
figure beside every line, recomputed on each page load, so a second number
written by the model is the one that can be wrong — and it would be the one a
merchant reads. It also makes staleness honest: because nothing stored holds a
figure, yesterday's briefing renders today's numbers under yesterday's
timestamp. Rejected: asking the model nicely not to (a prompt is a request, not
a rule), and letting it quote figures we then diff against ours (twice the work
and still a screen with two numbers on it).

## 2026-09-10 — ⌘J does not focus the Ask bar

The checklist asks for it. It needs a client-side key listener, and every admin
screen here is a props-only component with no client JavaScript — which is the
only reason any of their states can be exercised in an environment with no
Polaris and no Shopify session. Shipping an untestable listener into an embedded
iframe, where the host may well intercept the chord anyway, is worse than not
shipping it. Flagged as a user-visible gap. Rejected: an inline script in the
route (untestable here), and `accessKey` (a different chord, and a worse one).

## 2026-09-10 — PO-to-order reads text; PDFs and spreadsheets get the fallback

The checklist's dropzone takes pdf/xlsx/csv/eml. Neither a PDF parser nor a
spreadsheet reader is in the fixed stack, and adding one is a stack change this
file cannot make on its own. A file that cannot be read as text produces the
checklist's _own_ error state — "Couldn't read this PDF — paste the lines as
text?" — which is reached honestly rather than by omission, and the textarea
beside it always works. Rejected: adding pdf-parse and xlsx (a stack change, and
two more dependencies parsing hostile input), and silently accepting the upload
and failing later.

## 2026-09-10 — The Ask bar routes; it has no intent that writes

Claude maps a question to one of nine intents; eight are reads and the ninth
produces a link. There is no code path from the bar to a write, so "delete all
my rules" cannot execute — not because the prompt forbids it, but because the
destination does not exist. Rejected: a write intent behind a confirmation
dialog (a confirm is a UI, and a UI is not a security boundary), and letting the
model compose a query (an injection surface with the merchant's whole database
behind it).

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

## 2026-09-11 — Import refuses a file whose language disagrees with the page

`importStrings` refuses a whole file when its `locale` is not the language
selected on the page, rather than importing it into the selected language or
switching the page to the file's. A merchant who exports Arabic, edits it, and
imports it while English is selected would otherwise put Arabic wording on the
English storefront one string at a time, with nothing on the screen to say it
had happened — the kind of failure only a buyer finds. Rejected: importing by
the file's own locale regardless of the page (silently doing something the
merchant did not ask for) and ignoring the field (the same, with extra steps).
The error names the fix: switch the language above, then import again.

## 2026-09-11 — "✦ Fill missing" became "✦ Suggest wording in your voice"

Checklist §8 asks for *"✦ Fill missing with AI per language"*. Both catalogues
this app ships are complete in both languages, so a button that fills what is
missing would have had nothing to do on any store that ever installs it. The
mechanism is unchanged — the same model call, the same batch, the same
`needsReview` flag — but it is pointed at the strings the merchant has not
written themselves, in their own voice, using the brand-voice samples 6.5
stored and no prompt had read. It is still "fill missing per language" when a
future locale ships incomplete: `unwrittenIn` returns untranslated keys first
for exactly that case. Rejected: shipping the literal reading as an inert
button, which is the mistake this repo has caught three times already.

## 2026-09-11 — Orders over time ships as its own chart, in counts

The deferral above is now closed. `pages-features.md` §7 asked for "orders over
time"; it is an eighth card on the Analytics page, wholesale beside retail.

Three choices inside it, each the smaller of two evils:

**Its own chart, never a second axis on revenue.** A count and an amount are
different measures on different scales; drawn against one pair of axes,
whichever is smaller reads as "nothing happened".

**Bars at every window width**, where the revenue chart draws a line above a
week of history. A line between two orders and three draws two and a half,
which cannot have happened.

**Its own whole-number axis** (`wholeMax`), because `niceMax` rounds to 1, 2 or
5 times a power of ten — and five split into four bands labels the axis 5,
3.75, 2.5, 1.25. There is no such thing as 3.75 orders. The CSV has no currency
column for the same reason.

The ✦ ask bar's chart menu is now generated from a `Record<ChartKey, string>`
rather than typed out inside the prompt. It was a hand-kept list: adding
`orders` to `CHART_KEYS` would have satisfied the validator while the model was
never told the chart existed, so no question could ever route to it. That is the
same failure as `CATALOG_ROOTS`, `qa:capture`'s file list and the audit action
picker. `PROMPT_VERSIONS.ask_data` goes to "2" because the prompt changed.

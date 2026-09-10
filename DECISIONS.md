# Decisions

Judgment calls made without stopping to ask, one dated paragraph each: what was
chosen, why, and what was rejected. Newest first.

The long-form reasoning for architectural choices lives in `docs/adr/`; this
file is the running log, including the small calls that never earned an ADR.

---

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

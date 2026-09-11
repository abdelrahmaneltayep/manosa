# QA — 7.2 The three mandatory privacy topics, and a purge that reaches every table

Date: 2026-09-11 · Gate: **pass after a fix round** · Cold read: **FAIL** on
three P0s and seven P1s — see `COLD-READ.md`. This file describes the code as
it stands after those were fixed; §9 lists what the first pass got wrong.

## 1. Test plan

Two promises, both broken until this task.

Shopify requires every app in its store to subscribe to **`customers/data_request`,
`customers/redact` and `shop/redact`** and to answer them. This app subscribed
to none of the three: `shopify.app.toml` and `app/lib/webhooks/registry.ts` had
neither the topics nor the handlers, and the checklist line
(*"implement the mandatory GDPR topics with real data deletion"*) had been
carried in `PROGRESS.md` since 0.2.

`settings.danger.uninstallPolicy` tells a merchant, in their own admin, that
*"everything it stored about your shop is deleted within 48 hours"*. The purge
behind that promise cleared the **merchant's** two contact fields, redacted the
audit trail, and deleted agent conversations, writing samples and translated
strings. It did not touch a single buyer: names, addresses, phone numbers, VAT
numbers, the answers typed into registration forms, the documents uploaded with
them and every message ever sent to them all survived an uninstall
indefinitely. Invariant 4, in the place it matters most.

Abuse cases invented for this pass

1. A buyer who applied but never got an account — findable only by email.
2. The same person applying as `Dana@Acme.test` and ordering as `dana@acme.test`.
3. The same Shopify customer id in two shops — one person, two merchants.
4. A second delivery of `customers/redact` (Shopify delivers at least once).
5. `shop/redact` for a shop that does not look uninstalled here.
6. A redaction that would tear a hole in the merchant's revenue figures.

## 2. Automated

- `tests/integration/privacy.test.ts` — 11 tests, all new, driving the three
  topics through the **real signed-webhook route**, not the handlers directly.
- `tests/unit/privacy-coverage.test.ts` — 4 tests that read
  `prisma/schema.prisma` and fail the build when a model carrying personal data
  is not named by the purge, or not reachable by a single buyer's redaction.
  Every exemption is written down with its reason and checked to still exist.
- `tests/unit/webhook-registry.test.ts` — the existing drift test now covers
  three more topics in `shopify.app.toml`.

Each was watched failing: the purge with `db.customer`/`db.order` removed, the
redaction with its subscription removed, and the coverage guard with one table
dropped from the purge list.

## 3. The states, walked

Nothing here has a screen — which is the point of §4 below. What a merchant
sees is the audit log, and the two entries it writes are asserted for what they
say **and for what they must not say**: a request about a person's data,
answered by copying that data into a log a merchant reads in a list, would be a
worse answer than none.

## 4. Boundary

The hardest case in this task, and the one with three tests of its own: **a
Shopify customer id is the same value in every shop that person has bought
from.** So one merchant's deletion request must not reach another merchant's
record of the same human being. Alpha and Beta are seeded with the same buyer —
same customer id, same address — and after Alpha's redaction Beta still holds
their application, their customer row and their order with the address intact.
`buyerData`, `redactBuyer` and the purge all begin with `shopScope.require`.

## 5. Invariants

1. **Pricing engine** — untouched.
2. **Shop scope** — §4.
3. **AI drafts, a person approves** — nothing here calls a model.
4. **Nothing claims to have happened that did not** — this task exists because
   the app said something it had not done. The audit entries state counts and
   areas and never contents; `shop/redact` for a shop with no uninstall recorded
   writes the disagreement down rather than acting on a webhook nobody expected.
5. **Deciding shows its working** — the redaction says which records went and
   which were kept, and why: an order is the merchant's own accounting document,
   so the person comes out of it and the order stays.

## 6. The decision worth arguing with

**A single buyer's redaction deletes their application, their files, their mail
and their conversations — and redacts rather than deletes their orders and
quotes.** Deleting them outright is the more thorough-looking answer and, I
think, the wrong one: it would tear a hole in a trading merchant's revenue
figures to satisfy a request the law does not make, and the merchant is the
controller here. The name, the address, the email and the customer id come off;
the fact that an order of that value happened on that day stays.

The shop-wide purge is the opposite, and for the same reason: there is no
merchant left to be trading, so the orders go whole.

Recorded in `DECISIONS.md`.

## 7. Not covered here

- **No webhook has ever arrived from Shopify.** The signature scheme is
  implemented from the documented algorithm and tested both ways; these three
  topics are driven through the same signed route as every other, with a
  hand-built HMAC. Carried since 0.2.
- The uploaded files are rows in Postgres (`FormUpload.content`), so deleting
  the row is the whole deletion. If they ever move to object storage, that
  becomes a second place this has to reach — noted in `PROGRESS.md`.


---

## 8. Retention (the other half of 7.2)

Five tables that only ever grew, each with a window stated somewhere and
nothing behind it: `WebhookDelivery` (30 days), `FormEvent` (90, and the
conversion rate is computed over 30 — asserted), `RuleImportDraft` (7, against
a one-hour undo), archived `PricingRule`s (30, which is the number the audit
entry already tells the merchant), and `EmailMessage` (12 calendar months, the
same as the audit log). One job rather than five: the same question asked of
five tables, all wanting to run daily, and five self-requeueing jobs is five
chances for one to stop.

The windows are now **stated** in Settings beside the uninstall policy, and the
page that states them is the page that schedules the job — the rule this repo
arrived at when `purgeAudit` was written. `tests/integration/retention.test.ts`
is 9 tests.

## 9. What the first pass of this gate missed

The cold read returned FAIL on three P0s and seven P1s. Reading them in order,
three are worth writing down:

1. **`shop/redact` wrote the very flag the purge checks before deleting.** The
   purge refuses to run on a shop without `uninstalledAt`; the handler stamped
   one on and queued the purge for *now*. So one delivery for a shop whose
   `app/uninstalled` we had missed — or one replay with an unseen webhook id —
   deleted a live merchant's entire dataset with their staff still logged in.
   My own test asserted the tombstone was written and never called
   `runDueJobs()`, so it proved the first half of the bug and called it the
   feature.
2. **A reinstall never cleared `piiPurgedAt`.** The purge skips any shop that
   has one. Install → uninstall → purge → reinstall → trade for a year →
   uninstall deleted **nothing**, silently, for ever. It pre-dates this task;
   what this task did was turn it from two merchant fields into the whole
   buyer dataset.
3. **The coverage guard was vacuous where it mattered.** It classified nine of
   thirty-two models as personal by looking for eleven field names, and the
   buyer's uploaded trade licence was not among them — `FormUpload`'s columns
   are `fieldKey`, `fileName`, `contentType`, `byteSize`, `content`. The guard
   could be deleted from the purge and every test stayed green. It is a **total
   map** now: every model in the schema has a written disposition, and a new
   one fails the build until somebody says what happens to it. Rewriting it
   that way immediately found `AiRun`, which nothing had ever deleted.

And one that would have shipped the whole feature inert: the three topics were
declared with `topics = [...]` in `shopify.app.toml`. Privacy topics are not
registered through the API — `@shopify/shopify-api`'s own `register.ts` skips
every topic in its `privacyTopics` list — so they reach an app only under
`compliance_topics`. Shopify would never have been told where to send them.
`compliance_topics` ends in `topics`, so the drift test's regex matched both
and stayed green; it now tells them apart and requires each privacy topic under
the right key.

Also fixed: the person survived their own redaction in the audit log (as actor,
as subject and inside other people's sentences, in `summary` **and** in
`metadata`), in a quote's `requestNote` — documented in the schema as "what the
buyer asked for, in their words" — and in a monthly review's stored facts,
which are kept for ever by design. The `data_request` answer pointed at a buyer
page that loads none of the seven areas and does not exist at all for a
form-only applicant; it is a real download now, keyed on ids this app owns
rather than on the address, because putting a buyer's email into a log a
merchant reads for twelve months answers a question about their data by copying
it somewhere new.

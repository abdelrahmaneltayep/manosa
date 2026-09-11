# Cold read — 7.2 privacy (commit `89de3d3`, HEAD `4c84786`)

Reviewer: independent QA pass. I did not write this code.
Date: 2026-09-11 · Branch `claude/mannon-b2b-wholesale-oc5b18`

## Verdict: **FAIL**

Three P0s. Two of them destroy or preserve data in the opposite direction from
what the feature promises:

- one `shop/redact` delivery to a **shop that is installed and trading** deletes
  every buyer, order, quote, email and application it has — verified, not
  theoretical;
- a shop that uninstalls, reinstalls, trades for a year and uninstalls again is
  **never purged at all**, under copy promising 48 hours;
- `customers/redact` leaves the person's **email address, IP address and company
  name** in `AuditLog`, where the merchant reads them in a list for 12 months.

The build ran clean before this pass: `npm test` → 120 files / 2213 tests green,
`npm run lint` → clean, `npm run typecheck` → clean. Every finding below is a
thing the suite does not ask.

## Repro

Five failing cases are in `qa/7.2/cold-read/privacy-cold-read.test.ts`. Copy it
to `tests/integration/privacy-cold-read.test.ts` and run
`npx vitest run tests/integration/privacy-cold-read.test.ts`. It is kept out of
`tests/` so the committed suite stays green. All five fail against `4c84786`.

---

# P0

## P0-1 · `shop/redact` deletes a live merchant's entire dataset

`app/lib/webhooks/handlers/shop-redact.server.ts:22-31` and `:37`

```ts
if (record && !record.uninstalledAt) {
  console.warn(`[mannon] shop/redact for ${shop}, which has no uninstall recorded`);
  await db.shop.update({ where: { shop }, data: { uninstalledAt: new Date() } });
}
...
await enqueueJob({ kind: "shop.purge_pii", runAt: new Date(), replacePending: true });
```

`purgeShopPii` has exactly one safety catch — `if (!record.uninstalledAt) return
{ skipped: "reinstalled" }` (`purge-shop-pii.server.ts:22`). That catch is the
whole reinstall protection in this app, and it is the thing these four lines
switch off. The handler writes `uninstalledAt` onto a shop that has none, then
queues the purge **due now**, and the next job run deletes `Customer`,
`FormSubmission`, `FormUpload`, `EmailMessage`, `Quote`, `Order` (and
`OrderLine`/`Payment`/`QuoteLine`/`AgentMessage` by cascade) for a merchant who
is open for business.

Three ordinary ways this fires:

1. Merchant uninstalls, changes their mind and reinstalls on hour 20. Hour 48:
   Shopify's `shop/redact` arrives and wipes the store they just restored.
   `ensureShopRecord` cancelled the +47h job (`ensure-shop.server.ts:87`) — this
   path enqueues a fresh one that nothing cancels.
2. Any replayed or misrouted delivery with a `X-Shopify-Webhook-Id` this app has
   not seen. `dispatchWebhook` dedupes on `webhookId`, not on shop or topic.
3. Anyone who can forge one HMAC-valid POST — the blast radius of an API-secret
   leak goes from "read data" to "irreversibly delete a store's history".

Verified: `P0-1` in the repro file seeds an installed shop with `uninstalledAt =
null`, delivers one signed `shop/redact`, runs the queue, and finds
`Customer.count() === 0`, `Order.count() === 0`, `piiPurgedAt` set.

The comment on the handler says it records the disagreement "because the
alternative is deleting a live merchant's data on a webhook we did not expect."
It does both: it records the disagreement *and* deletes the data. The integration
test at `tests/integration/privacy.test.ts:322-336` carries the same claim —
*"write the disagreement down rather than deleting a live merchant's data"* —
and never calls `runDueJobs()`, so it asserts the comment rather than the
behaviour. `qa/7.2/REPORT.md` §5 repeats the claim as an invariant-4 pass. That
is Invariant 4 broken inside the document that certifies it.

Expected behaviour to argue about, not to assume: for a shop with no
`uninstalledAt`, this should almost certainly record the disagreement, respond
200, and **not** enqueue — or enqueue at +47h so a live merchant's next page view
cancels it, which is the mechanism the rest of the app already relies on.

## P0-2 · A reinstalled shop is never purged again

`app/lib/jobs/handlers/purge-shop-pii.server.ts:23` +
`app/lib/shop/ensure-shop.server.ts:84-87`

`purgeShopPii` returns `{ skipped: "already purged" }` when `piiPurgedAt` is set.
The reinstall path clears `uninstalledAt`, `customersBackfilledAt` and
`ordersBackfilledAt` — and **not** `piiPurgedAt`. `grep -rn piiPurgedAt app/`
returns three sites: the skip, the write, and a read into an audit `metadata`
field at `ensure-shop.server.ts:129`. Nothing ever clears it.

So: install → uninstall → purge (sets `piiPurgedAt`) → reinstall → trade for a
year → uninstall. The second purge runs, finds `piiPurgedAt`, and returns
without deleting a single row. Every buyer's name, address, phone, VAT number,
form answers, uploaded trade licences and every message sent to them stay in
this app for ever, while `settings.danger.uninstallPolicy` (`en.json:2758`) tells
the merchant *"everything it stored about your shop is deleted within 48 hours"*.
It is silent: the job records `skipped`, no audit entry is written, nothing on
any screen says the promise was not kept.

This bug predates 7.2, but 7.2 is what made it matter. Before this commit the
skipped purge withheld two merchant contact fields; now it withholds the entire
buyer dataset that 7.2 was written to delete. It is squarely in scope for a task
whose subject line is "a purge that reaches the buyers", and the coverage guard
7.2 added does not look at it.

Verified: `P0-2` in the repro file. After the second uninstall,
`Customer.count() === 1` and `Order.count() === 1`.

## P0-3 · `customers/redact` leaves the person in the audit log

`app/lib/privacy/buyer-data.server.ts:130-190` (no `db.auditLog` call at all)

`redactBuyer` never touches `AuditLog`. The production writers put the buyer
into it in four ways:

| what | where | example row (captured from the real writer) |
| --- | --- | --- |
| email as `actorLabel` | `app/lib/forms/submissions.server.ts:229` (`actor: { type: "BUYER", label: email }`) | `"actorLabel":"dana@acme.test"` |
| IP address | same call, `ip` at `submissions.server.ts:238` | `"ip":"203.0.113.7"` |
| email/company in `summary` | `forms/decisions.server.ts:273,373,427,493`; `forms/submissions.server.ts:232`; `quotes/quotes.server.ts:385-386`; `customers/customers.server.ts:238,370-371` (via `describe()` at `:333`, which returns `company \|\| "First Last" \|\| email`) | `"Rejected dana@acme.test (…)"`, `"Sent Q-1001 to dana@acme.test."` |
| email/VAT in `metadata` | `terms/reminders.server.ts:103` (`metadata: { to: order.email }`), `customers/customers.server.ts:326` (`metadata: { vatNumber }`) | `"metadata":{"to":"dana@acme.test"}` |

After a `customers/redact` all of it is still there, readable at
`/app/activity`, filterable, and retained for twelve months by `audit.purge`.
The `subjectId` now dangles at a `FormSubmission` that no longer exists, so the
row is useless as an audit trail and intact as a personal-data record — the
worst of both.

Verified: `P0-3` in the repro file drives the **real** `submitForm` writer (not a
fixture), delivers a signed `customers/redact`, and dumps `AuditLog`. Actual
output includes `"actorLabel":"dana@acme.test"` and `"ip":"203.0.113.7"`.

The guard that was supposed to catch this excuses `AuditLog` as *"redacted in
place"* (`tests/unit/privacy-coverage.test.ts:78-80`). That excuse describes the
shop purge, which nulls three columns — `actorId`, `actorLabel`, `ip`
(`purge-shop-pii.server.ts:44-47`). It is not true of `summary`, `metadata` or
`subjectId` in either path, and it is not true of `customers/redact` in any
column. See F-9.

---

# P1

## P1-4 · The shop purge leaves buyer emails and VAT numbers in `AuditLog`

`app/lib/jobs/handlers/purge-shop-pii.server.ts:44-47`

The same table, the other path. The purge nulls `actorId`/`actorLabel`/`ip` and
leaves `summary` and `metadata` untouched — so after `shop/redact` the database
still holds `"Rejected dana@acme.test (no_trade_reference)"`,
`"metadata":{"to":"dana@acme.test"}` and `"metadata":{"vatNumber":"GB123456789"}`
for every buyer the shop ever dealt with, under copy that says everything is
gone within 48 hours. Separated from P0-3 because it needs a different fix:
redaction-in-place cannot work on a free-text `summary`, so either the summaries
stop embedding identifiers or the purge deletes the rows.

## P1-5 · The three topics are declared with the wrong TOML key and will not register

`shopify.app.toml:52-62`

```toml
[[webhooks.subscriptions]]
topics = [ "customers/data_request" ]
uri = "/webhooks/customers/data-request"
```

The three mandatory privacy topics are **compliance topics**, not subscribable
ones. Shopify's own library says so in the copy that is vendored into this repo:
`node_modules/@shopify/shopify-api/lib/webhooks/register.ts:76`

```ts
if (privacyTopics.includes(topic)) {
  continue;   // CUSTOMERS_DATA_REQUEST, CUSTOMERS_REDACT, SHOP_REDACT — lib/types.ts:58
}
```

They are configured through `compliance_topics = [...]` on a
`[[webhooks.subscriptions]]` block (or the Partner Dashboard), not `topics`.
Declared as `topics`, `shopify app deploy` will either reject the config or
accept it without ever subscribing — and the app URIs in this commit will never
receive a delivery. The whole of 7.2 would ship inert in production, which is the
"a prompt version is not a feature" shape this repo has hit four times.

`tests/unit/webhook-registry.test.ts` cannot see it: `declaredSubscriptions()`
(`:18-31`) only parses `topics = [...]` and compares the TOML against the app's
own registry. It checks the two halves against each other, and neither half is
Shopify.

I could not confirm against `shopify.dev` — no egress, per `PROGRESS.md`. The
evidence above is from Shopify's shipped source in `node_modules`. **Verify
against the CLI's TOML schema before fixing**, and note that the
handler/dispatch/registry side is correct and can stay as it is.

## P1-6 · The `customers/data_request` answer cannot be used to answer anybody

`app/lib/webhooks/handlers/customers-data-request.server.ts:44-56`

The handler counts seven areas and writes: *"A buyer asked what Mannon holds
about them: 9 record(s) across customers, applications, uploads, emails, orders,
quotes, conversations. **Open their buyer page to see it.**"*

The buyer page is `app/routes/app.customers.$id.tsx`. Its loader (`:65-113`)
builds name, company, phone, VAT, tags, group, terms and the ledger summary. It
loads **none** of the seven: no applications, no uploads, no emails, no quotes,
no conversations, no orders list. `grep -n "emailMessage\|agentConversation\|
formUpload\|formSubmission" app/routes/app.customers.$id.tsx` returns nothing.

And for the case this feature makes a point of supporting — the applicant who
never got a Shopify account, found by email only — there is no `Customer` row, so
there is **no buyer page at all**. The merchant is sent to a 404 to satisfy a
regulator's 30-day deadline.

Invariant 4: the sentence names a place that cannot answer, and for one class of
buyer does not exist. Either the summary stops promising a page, or something has
to assemble the data (an export is the obvious shape — `buyerData` already
returns the rows).

## P1-7 · A buyer's own words on a quote survive their redaction

`app/lib/privacy/buyer-data.server.ts:180-184`

```ts
db.quote.updateMany({
  where: { OR: both },
  data: { customerId: null, email: null, company: null },
}),
```

`Quote.requestNote` is documented in the schema (`prisma/schema.prisma:1287`) as
*"What the buyer asked for, in their words."* It is free text a buyer typed and
it routinely carries a name, a delivery address or a phone number. It is not in
the `data`. Neither is `Quote.internalNote` (staff notes *about* this person) nor
`Quote.message`. Same shape on the order side: `Payment.reference` is free text
("bank transfer, ref …") that survives, and `Customer.internalNote` is fine only
because the whole row is deleted.

Verified: `P1-4` in the repro file seeds a quote whose `requestNote` is
`"Dana Bright, 12 Mill Lane, Leeds LS1 1AA — please call me on +44 7700
900123."`, delivers `customers/redact`, and reads it back unchanged.

`DECISIONS.md` argues for keeping the order and the quote as business records.
That argument covers the *amounts and dates*. It does not cover free text the
person wrote, and the entry does not mention these columns at all.

## P1-8 · `MonthlyReview` names the shop's top buyer, for ever

`app/lib/analytics/review.server.ts:342-344` → `review-run.server.ts:128-136`

```ts
slots[at("n1")] = facts.topBuyer.label;   // order.company ?? order.customerId  (review.server.ts:231)
```

`MonthlyReview.facts.slots` is written with the top buyer's **company name** and
is kept for ever by design (`prisma/schema.prisma:1473-1478`: *"Kept forever,
unlike the daily briefing"*). It is not touched by `redactBuyer` and it is not
named by the shop purge. Same exposure, lower confidence, in
`MerchantBriefing.items[].reason`: the fact assembler passes
`subject: company ?? email` (`app/lib/agent/facts.server.ts:263,279`) and the
prompt renders it as `about: dana@acme.test`
(`app/lib/ai/prompts/briefing.server.ts:67`), so the model's stored free-text
line can carry it back.

For a sole trader the company name *is* the person's name. This is a table the
7.2 guard was written to find and cannot see, because the column is
`facts Json` — see F-9.

## P1-9 · The coverage guard is vacuous where it matters most

`tests/unit/privacy-coverage.test.ts:37-49, 62-85`

The guard's `PERSONAL` list is eleven field names. Running its own classifier
over the schema (`node`, same regex):

```
PERSONAL-matched (9):  Session Shop AuditLog Customer FormSubmission
                       EmailMessage Order Quote AgentConversation
NOT matched (23):      WebhookDelivery ScheduledJob PricingRule RuleImport
                       RuleImportDraft CustomerGroup CustomerTagRule
                       RegistrationForm FormUpload FormEvent BlockedDomain
                       OrderLine AiRun QuoteLine Payment OrderLimit
                       CustomerSegment MerchantBriefing MonthlyReview
                       AgentGuardrails AgentMessage BrandVoiceSample
                       StorefrontString
```

Consequences:

- **`FormUpload` is not personal data to this guard.** The buyer's uploaded
  trade licence — the one thing in this app that `PROGRESS.md` says "no apology
  recovers" — has field names `fieldKey/fileName/contentType/byteSize/content`,
  none of which are in `PERSONAL`. Delete `db.formUpload.` from both the purge
  and `redactBuyer` and all four tests still pass. Same for `AgentMessage.text`
  (a buyer's own words), `Payment.reference`, `MonthlyReview.facts`,
  `MerchantBriefing.items`, `RuleImportDraft.content`, `BrandVoiceSample.body`.
- **Five of the nine `ELSEWHERE` excuses never fire.** `OrderLine`, `Payment`,
  `QuoteLine`, `AgentMessage` and `BlockedDomain` are not in `personal`, so they
  are never filtered against the excuse list. The `"excuses nothing that does not
  exist"` test (`:126-134`) only asserts the model **name** appears in the
  schema — it never asserts the excuse is load-bearing. Five entries of written
  reasoning that guard nothing, presented in the commit message as the thing
  that makes this list trustworthy.
- **One excuse is factually false.** `BlockedDomain: "a merchant's own setting,
  not a person"` adds *"it is deleted with the shop's rows anyway when they
  uninstall — see the shop-scoped cascade in the schema"* (`:82-84`). **There is
  no shop-scoped cascade.** `model Shop` has no relation fields at all, and the
  live FK set confirms it:

  ```
  AgentMessage→AgentConversation c   FormUpload→FormSubmission c   OrderLine→Order c
  Customer→CustomerGroup n           OrderLimit→CustomerGroup c    Payment→Order c
  FormEvent→RegistrationForm c       FormSubmission→RegistrationForm c
  QuoteLine→Quote c
  ```

  Nine foreign keys, none to `Shop`. `BlockedDomain` — `domain` plus a free-text
  `reason` — is deleted by nothing, ever.
- The `"finds some, rather than quietly matching nothing"` test (`:88-95`) is the
  right instinct aimed at the wrong risk. It catches the regex breaking
  wholesale; it cannot catch the regex being narrower than the schema, which is
  the failure that is actually present.

Verified: `P1-5` in the repro file seeds a `BlockedDomain`, runs the full
`shop/redact` → purge path, and finds the row still there.

## P1-10 · The `ELSEWHERE` excuse for `Session` is right for the wrong path

`tests/unit/privacy-coverage.test.ts:66-68` — *"deleted by the uninstall webhook"*.
True for `app/uninstalled` (`app-uninstalled.server.ts:29`) and for the purge's
raw `DELETE` (`purge-shop-pii.server.ts:88`). Not true for `shop/redact` arriving
at a shop with no uninstall record: the sessions of a live shop are left in place
while every one of its buyers is deleted. Falls out with P0-1.

---

# P2

- **`identityFrom` drops `orders_to_redact` and `data_request.id`.**
  `customers-data-request.server.ts:23-32`. Shopify's documented payloads carry
  `orders_requested` / `orders_to_redact` (order ids to act on) and a
  `data_request.id` (the request's own identifier). Redacting *all* of the
  buyer's orders is a defensible superset — but a guest-checkout `Order` mirrored
  with no `customerId` and no `email` is reachable **only** via
  `orders_to_redact` and is missed. Dropping `data_request.id` means the audit
  entry cannot be tied to the request Shopify assigned, which is the one number a
  regulator would ask for. `customer.phone` is also dropped, though
  `Customer.phone` is stored and indexed. The GID construction from a numeric
  `customer.id` is correct and worth keeping.
- **The `metadata` of both privacy entries stores the person's `customerId`**
  (`customers-data-request.server.ts:62`, `customers-redact.server.ts:35`).
  Defensible as a record of processing, but it is the pseudonymous identifier of
  somebody who just asked to be forgotten, and `DECISIONS.md` does not mention
  it. Decide it out loud.
- **`buyerData` loads file bytes to count them.** `buyer-data.server.ts:89-91`
  does `db.formUpload.findMany` with no `select`, so `content` (`Bytes`) is
  pulled into memory for every upload — then the handler uses only `.length`
  (`customers-data-request.server.ts:46-48`). A buyer with twenty 5 MB documents
  is 100 MB on a webhook Shopify expects answered in 5 seconds. Same shape on
  `db.order.findMany({ include: { lines: true, payments: true } })` (`:95-98`) —
  no `take`, so a large buyer's whole order history is materialised.
- **Mail to a superseded address survives.** `EmailMessage` has no `customerId`
  and no `submissionId` on reminder mail (`terms/reminders.server.ts:80`), so it
  is matched only on `to`. A buyer who changed their email address keeps every
  message sent to the old one, body and name included. Same if Shopify's redact
  payload arrives with a null `email`.
- **Guest `AgentConversation` rows are unreachable.** `redactBuyer` matches
  conversations on `customerId` only (`buyer-data.server.ts:169-172`), and a
  guest thread has `customerId: null` with a `guestKey` (`schema.prisma:1570`)
  and the buyer's own words in `AgentMessage.text`. `customers/redact` for a
  person who later signed in cannot reach the turns they typed before they did.
- **`privacy` is not a known activity family.** `activityKindLabel`
  (`app/lib/agent/home-view.server.ts:243-262`) has sixteen families and none of
  them is `privacy`, so all three new actions render under the generic "Other"
  chip. Not a raw key — the label itself is derived (`feed.server.ts:344-359`) —
  just the only family in the app without its own chip.
- **`FormUpload.submissionId` is nullable** (`schema.prisma:879`) and
  `redactBuyer` reaches uploads only through it. Today every writer creates
  uploads nested inside the submission (`submissions.server.ts:209`,
  `:394`), so no orphan exists — but the column permits one, and an orphan would
  be invisible to `customers/redact` while the shop purge would still catch it.
- **`WebhookDelivery`, `RegistrationForm`, `FormEvent`, `RuleImport`,
  `RuleImportDraft`, `CustomerSegment`, `AgentGuardrails`, `PricingRule`,
  `CustomerGroup`, `CustomerTagRule`, `OrderLimit`, `AiRun`, `MerchantBriefing`,
  `MonthlyReview` all survive the shop purge.** Most of it is merchant
  configuration and the `Shop`-row reasoning ("what lets a reinstall restore
  their setup") arguably extends to it — but nothing says so anywhere, the
  Settings copy says "everything", and two of the fourteen
  (`MonthlyReview`, `MerchantBriefing`) carry buyer identifiers (P1-8).
  `RuleImportDraft.content` is a file the merchant uploaded. Either the copy
  narrows or the list grows; right now the copy is the broader claim.
- **`qa/7.2/REPORT.md` §5 certifies the invariant P0-1 breaks.** *"`shop/redact`
  for a shop with no uninstall recorded writes the disagreement down rather than
  acting on a webhook nobody expected."* It acts. A QA report is the last place a
  claim should outrun the code.

---

# What is right, and worth not breaking in the fix round

- **Tenancy holds.** `scopeWhere` merges `{ ...where, shop }`
  (`app/lib/tenant/shop-scope.server.ts:83-86`), so an `OR` clause is ANDed with
  the shop rather than widening past it, and `deleteMany`/`updateMany` are both
  in `WHERE_OPERATIONS`. The `db.formUpload` / `db.emailMessage` queries that
  filter on `submissionId` are safe twice over: the extension injects `shop`, and
  `submissionIds` came from a shop-scoped read. The three cross-tenant tests are
  real tests and they pass. I attempted the same-customer-id-in-two-shops case
  from the redaction side and could not get a row to cross.
- **HMAC and idempotency are real.** `tests/support/webhook-request.ts` signs the
  body the way Shopify does rather than stubbing verification, and the route runs
  `authenticate.webhook` before anything else. A replay of a handled delivery
  short-circuits on `WebhookDelivery` (`dispatch.server.ts:58`); a replay of a
  failed one re-runs, which is right.
- **Topic normalisation is correct.** `customers/data_request` →
  `CUSTOMERS_DATA_REQUEST` matches the header shopify-app-remix returns.
- **The cascades the excuses rely on are real at the database level**, confirmed
  against `pg_constraint` (nine FKs, all `ON DELETE CASCADE` except
  `Customer→CustomerGroup`, which is `SET NULL` and correct).
- **Case-insensitive email matching**, and finding a buyer who only ever filled
  in a form, are both right and both tested from the production writer's side.
- **Not writing the buyer's rows into the audit entry** is the right call, and
  the tests assert the absence rather than the presence.

# Required before this can pass

1. Fix P0-1, P0-2, P0-3 and re-run the whole suite, not just `privacy.test.ts`.
2. Fix P1-5 or say plainly in `PROGRESS.md` that the topics are declared in a
   form that has never been validated against Shopify — this is the difference
   between shipping the feature and shipping the name of it.
3. Widen the coverage guard (P1-9) **before** the other fixes, not after. Every
   P0 and P1 above except P1-5 and P1-6 is a table or a column the guard was
   written to find and does not look at; fixing the findings without fixing the
   guard leaves the next table to the next cold read.
4. Delete or correct the five vacuous `ELSEWHERE` entries and the false
   `BlockedDomain` cascade claim.
5. Correct `qa/7.2/REPORT.md` §5 and the comment at
   `tests/integration/privacy.test.ts:322-336`.

# What this pass did not prove

- **No webhook has ever arrived from Shopify**, so topic headers, payload shapes
  and the compliance-topic registration are all asserted against a documented
  algorithm and a vendored library, never against Shopify. P1-5 is the sharp end
  of that.
- **No screen.** This task has no capture set and needs none — but P1-6 is a
  finding *about* a screen, and the buyer page was read, not run.
- **`orders_to_redact` / `data_request.id` payload shapes** are from memory of
  Shopify's documentation; `shopify.dev` is unreachable here. Confirm before
  acting on that P2.

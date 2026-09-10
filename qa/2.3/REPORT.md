# QA report — 2.3 · Approval pipeline: queue, approve/reject, emails, evaluator


Reviewed as someone who did not write it and does not trust it.

### 1. Test plan

The spec: checklist §3's "Pending approvals" block, plus the approval logic
§4 puts on the form. ✦ AI screening is 4.3; the plain-English version of the
criteria is 4.3 as well. This task owns the queue, the three decisions, the
notification emails, and the deterministic evaluator behind them.

Happy paths: an application arrives and waits; a merchant approves it into a
tier and the buyer becomes a tagged Shopify customer; a merchant rejects one
with a reason and the applicant is told; a merchant asks for more and the
application stays in the queue; the evaluator approves one that meets every
criterion.

Invented abuse cases:

1. **Malformed input.** A stored criterion of an unknown kind; a country
   criterion with an empty list; a rejection with no reason; an empty
   "ask for more"; a merge tag in a per-send email override.
2. **Concurrency and timing.** Two reviewers approving the same application;
   undo after the ten seconds; undoing something never approved; the evaluator
   failing on one application and being asked to run again.
3. **Wrong shop.** Approving another shop's application; one shop's blocked
   domain leaking into another's; one shop's sent messages appearing in
   another's records.

### 2. Automated tests

`npm test` — **753 tests, 38 files, all passing** (679 at 2.2). New:

- `tests/unit/approval.test.ts` (25) — every criterion, the "all of, never any
  of" rule, failing closed on an unknown country, refusing to decide when a
  stored criterion could not be read, and defensive parsing.
- `tests/integration/approvals.test.ts` (29) — approve creating a customer and
  approve attaching to an existing one, the email that goes with each, undo
  inside and outside the window, rejection with a reason, blocking a domain and
  the next application from it, "ask for more", the evaluator via its job, and
  four tenant-isolation cases.
- `tests/unit/email-transport.test.ts` (10) — transport selection from the
  environment, refusing to pretend a provider is configured, the Resend request
  shape, carrying the provider's error text, and the timeout.
- `tests/unit/applications-page-states.test.tsx` (20) — every state below.

`npx playwright test` — **159 passing** (140 at 2.2).

Lint, `tsc --noEmit`, `npm run build` and `prettier --check` are clean.

### 3. State walkthrough

18 states captured to `qa/2.3/`. Queue: empty with the link to share, empty
with no form yet, loading skeletons, ideal, screening unavailable, criteria met,
criteria not met, the edge cases (already a customer, others from the same
domain, an unscanned upload), the undo window, undo after it closed, no mail
provider, editing the email before sending, no results, paginated, Arabic.
Auto-approval editor: off, criteria as sentences, switched on with nothing to
check.

### 4. Cross-tenant check

Four cases, all holding: approving another shop's application is refused with
404 **before any Admin API call is made**; a blocked domain in one shop is not
blocked in another; one shop's applications never appear in another's queue;
one shop's `EmailMessage` rows never appear in another's. `BlockedDomain` and
`EmailMessage` both carry `shop`, so the DMMF-driven guard picks them up with
no registration step.

### 5. The three musts

| Rule                                           | Status at 2.3                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | Held. Approving sets a buyer's tier and tags; the price that follows is computed by the engine at checkout, as before.                                    |
| No AI mutation without an approval record      | Held, and nothing here is AI. The evaluator is deterministic, and every decision it makes is recorded with `decidedAutomatically` and a SYSTEM audit row. |
| No unhandled promise rejections in the e2e run | Clean.                                                                                                                                                    |

### 6. Bugs found and fixed

1. **A raw catalog key rendered to the merchant.** The queue showed
   `applications.reason.met.years_in_business` where a sentence belonged:
   i18next resolves a pluralised key only when handed a `count`, and the
   component passed only `detail`. Found by reading a capture. Fixed, and then
   made unrepeatable: **every capture in the project is now checked for raw
   catalog keys**, which is a guard the other four state suites did not have.
   (They all passed it, so this was the only one.)

2. **The email transport was never registered.** `configureEmailFromEnv` was
   written and never called, so the app would have been permanently in "no
   sender" mode however the environment was set — the one failure mode this
   whole module exists to make loud. It is now called where the transport is
   needed, and covered by a test.

3. **A list of reasons under "does not meet your criteria" mixed satisfied and
   unsatisfied lines** with nothing to tell them apart, hiding the one thing a
   merchant opens that banner to find. Each line now carries a met/not-met
   badge. Found by looking at `07-queue-criteria-not-met.png`.

4. **The queue's verdict could disagree with the evaluator's.** The queue built
   its facts from a `uploads` selection that did not include `fieldKey`, so a
   `has_upload` criterion was always unmet on screen and could be met in the
   job. Preview and apply have to be the same answer; found by reading the
   query rather than by a test.

5. **A `send_timeout` that could not be tested** without ten seconds of real
   waiting. Made injectable, which turned a 10s test into a 20ms one.

One more was in a test rather than the code: an assertion that the evaluator
"examines nothing" when switched off, when what it actually does — and should
do — is look, decide nothing, and stamp the application so it is not looked at
again.

### 7. Open items

- **Still not seen in a real Shopify admin**, now across four phases. The buyer's
  form remains the only surface exercised in a browser.
- **`customerCreate` and `customerUpdate` are pinned, not exercised.** The
  approval path's Admin API calls are asserted by their exact query and
  variables against a fake. Whether Shopify accepts a phone in the shape we send
  it, or what it does with a duplicate email, is unverified without a store — the
  code is defensive about both.
- **✦ Screening is not built** (4.3). The queue shows the neutral "screening
  unavailable" state and never blocks approving.
- **No merge, and no "convert existing customer" button.** The queue flags
  applications from the same domain and applicants who already have an account,
  and approving attaches to that account rather than making a second one. What
  is missing is an explicit merge action, which is a destructive operation on
  somebody else's data and not one to run on a hint.
- **No email is actually sent in this environment.** There is no provider key
  here, so the Resend transport has never made a real request. The request shape
  is asserted; the response is not.
- **The evaluator has no plain-English editor.** Criteria are structured, and
  the "auto-approve if VAT valid AND years ≥ 2" sentence the checklist asks for
  is the AI layer's job in 4.3. The structured form is what it will write into.
- **`EmailMessage` rows are never pruned**, and neither are `FormEvent` rows.
  Retention lands in 7.2.

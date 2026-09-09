# 13. Approving a buyer: reasons, ten seconds, and a job

Status: accepted (phase 2.3)

## Context

Approving a wholesale application is the moment somebody starts buying at
wholesale prices. Getting it wrong in one direction turns away a real customer;
in the other it sells at trade prices to somebody who resells against the
merchant. Both are quiet failures — nobody finds out for weeks.

## A rejection always carries a reason

`rejectSubmission` will not run without one. The reason is a code the merchant
picks from a list, plus whatever they type; only the typed part is sent, because
"competitor" is not a sentence to send anyone.

The point is not bookkeeping. An applicant who writes back asking "why?"
deserves an answer somebody can actually give, and a queue full of rejections
with no reasons is a queue nobody can audit or learn from.

## Undo is ten seconds, and it is not a decision

An approval can be taken back for ten seconds: long enough to notice you
clicked the wrong row, short enough that nothing has acted on it. After that,
reversing an approval means _rejecting_ the buyer, which is a decision with a
reason attached — and undo has none.

Undo removes what the approval added — the tags, the group, the wholesale
status — and returns the application to the queue. It does **not** delete the
Shopify customer. Deleting a customer account is destructive and irreversible;
a stray account nobody has used costs the merchant nothing. The audit entry
says one was left behind, so the record is not misleading.

## The evaluator runs in a job, not in the request

Auto-approval takes several Admin API calls: find or create the customer, tag
them, publish their checkout facts. A buyer who has just pressed "send" should
not be waiting on any of that, and — more importantly — if it fails, the
application must still be sitting safely in the queue for a person.

So `submitForm` stores the application and enqueues `forms.decide_applications`.
The job claims work by stamping `autoEvaluatedAt` **before** deciding, so an
application that throws every time is looked at once rather than blocking the
queue behind it forever.

## The evaluator's rules

- **Off by default.** Deciding on its own is something a merchant switches on.
- **On with no criteria decides nothing.** "I switched it on" must not read as
  "I approved everybody".
- **Every criterion must hold — there is no "any of".** A rule that fires when
  any condition holds grows more permissive with each line the merchant adds,
  which is the opposite of what adding a line reads like.
- **Unverified is not valid.** A `vat_valid` criterion needs VIES to have said
  yes. Approving on "we could not check" turns somebody else's outage into a
  wholesale account.
- **An unknown country satisfies nothing**, in or out. We do not know where
  they are, so failing closed sends it to a person.
- **A criterion we cannot read switches the whole rule off.** Dropping one makes
  the rule _wider_, and a wider auto-approval rule approves people the merchant
  never meant to.
- **Rejecting automatically is possible and not the default.** The setting says
  what it means before it is chosen: it turns somebody away without a person
  reading their application.

The queue shows the working, not just the verdict, and marks each line met or
not met. A merchant handed "meets your criteria" with nothing behind it cannot
tell a good rule from one that is letting everybody through.

## Email: recorded first, sent second

Every message is written to `EmailMessage` before it is attempted and updated
after. "Did they ever hear from us?" then has an answer that does not depend on
a provider's dashboard, which is what a merchant needs when an applicant says
they got nothing.

A failed send never fails the decision that asked for it. Approving a buyer and
then rolling it back because a mail provider had a bad minute would leave the
merchant with a decision they made and the app disagreeing.

The transport is chosen from the environment — Resend over its HTTP API (one
POST, no SDK: a mail provider is not worth a dependency here), or a `log`
transport for development. With neither, nothing pretends: the message is
recorded as failed with the reason, and the queue says plainly that no
applicant is being told anything.

## Blocked domains

Rejecting can also close the door on the sender's domain. Later applications
from it are stored as rejected and answered as success — a blocklist a spammer
can probe is a blocklist that tells them what to change, and a person whose
employer's domain a merchant blocked should hear that from the merchant rather
than from a form.

## What this deliberately does not do

- **✦ Screening is not built.** Checking a company's website, matching an email
  domain against it, scoring for spam — all of that is the AI layer (4.3). The
  queue renders the checklist's "screening unavailable — review manually" state,
  and it has never blocked approving anybody.
- **Approving does not delete or merge duplicate applications.** The queue
  flags others from the same domain and flags an applicant who already has an
  account, which is what a person needs to make the call. Merging two
  applications is a destructive operation on somebody else's data, and it is
  not one this app should do on a hint.

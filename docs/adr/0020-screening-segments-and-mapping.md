# 20. Four features that read, and one rule they all follow

Status: accepted (phase 4.3)

## Context

Phase 4.3 adds the AI features that _read_ something a merchant already has:
an application (screening), a template (a drafted email), their customers (a
segment), and their spreadsheet (the CSV whisperer).

Reading is where the risk changes shape. 4.2's rule-from-a-sentence produced
something the merchant reviewed before it existed. These four are handed real
data about real people — an applicant's business, a buyer's spend, a supplier's
price sheet — and three of them produce something a merchant will act on
quickly, in a queue, one row at a time.

## Decision

### What leaves is a fact, never a person

The screening prompt carries a company name, an email _domain_, and signals this
app derived. It carries no name, no email address, no phone number and no
free-text answer, because there is nowhere in `ScreeningFacts` to put one —
`factsForScreening` is the only thing that builds one, and
`tests/unit/screening.test.ts` asserts its shape.

The email draft is the same rule from the other side: it writes to
`{{first_name}}` and never learns who that is. The merge tag is filled at send
time, by the send path, from the database.

The CSV whisperer sees column _names_ and three sample values per column — the
evidence needed to tell a price from a quantity, and nothing more. It never
rewrites a value; a mapping renames headers, and the same planner, the same row
numbers and the same error report run afterwards.

### What comes back is a code, never a sentence

A screening verdict is a decision plus up to three **signals** from a closed
list of nineteen. The merchant reads our sentence, in their language, from our
own catalogue. A model cannot invent a reason about a real business, and a
merchant in Arabic gets Arabic.

This is also what makes the verdict auditable — invariant 5. Every reason ties
to a fact the app holds and could be checked by hand.

The same shape guards the other three: a segment is conditions from a closed
grammar, checked by the reader that also guards a hand-built one; a mapping is
template column keys, checked against the actual template and the actual file;
an email draft may use only merge tags the send path can fill.

### The screening never decides, and says which kind of silence it is

`WAITING` is "not looked at yet". `UNAVAILABLE` is "it ran and could not
answer". `OFF` is "there is no key, so nothing was attempted". Three sentences,
because a merchant acts differently on each — and none of them is the fourth
thing, "we looked and it is fine", which only `RECOMMEND` means.

A job marks a keyless shop's applications `OFF` rather than leaving them
`WAITING`: a queue that says "checking…" for ever is a worse lie than "not
screened". Approve and reject stay live in all five states.

### The website is compared, not fetched

The checklist says "Checking website & VAT". The VAT check is real — VIES, from
2.2. The website is **not fetched**: we compare the domain the applicant typed
to the domain they email from.

Fetching an address a stranger supplied, from our server, is a request we would
be making on their behalf to somewhere we have never heard of — the shape of
every SSRF. The comparison is a real signal and costs no request, and the copy
says what was actually checked rather than implying a visit.

### A segment is a filter, not a list

"Spent over $5,000, quiet for 45 days" stays true as the customers change. A
list of 84 people captured in March is wrong by April and nothing says so.

Conditions are ANDed and there is no nesting. A row of chips is what a merchant
means and what fits on a screen; an OR three deep is a query builder, and a
query builder is the thing this feature exists to avoid. Someone who needs one
saves two segments.

Turning a segment into a pricing rule's audience takes a **snapshot** —
`segmentMemberIds` — and the rule says so. Making it live would mean publishing
each buyer's segment membership to checkout the way tags and groups are
published, which is a phase of its own.

"No one matches" names the chip to loosen, chosen by counting without each
condition in turn and taking the one whose absence helps most. Arithmetic, not
a guess, and only run when the merchant is already stuck.

### Group names in, group ids out

Same rule as 4.2, for the same reason and with the same consequence: resolution
can only emit an id that was in this shop's grounding, so a tampered payload
naming another shop's group resolves to nothing and reads as an unanswered
question rather than a leak.

## Consequences

- `FormSubmission` grows five screening columns and a `ScreeningVerdict` enum;
  `CustomerSegment` is a new table; `RuleImportDraft` gains the confirmed
  mapping so confirming imports exactly the file that was reviewed.
- A Polaris `s-button` carries no `name` or `value`, so one form is one intent.
  The ✦ draft-email control is therefore a link the loader handles, not a second
  submit — and the draft writes around `{{reason}}` so it reads correctly
  whichever reason the merchant picks afterwards.
- Screening costs one model call per application. It is claimed by `screenedAt`
  and never repeated: a verdict that changes on refresh is not one a merchant
  can act on.

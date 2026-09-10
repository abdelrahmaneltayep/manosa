# 19. A rule from a sentence, and a guard that does the arithmetic

Status: accepted (phase 4.2)

## Context

Checklist §2 asks for one sentence — "buy 10 get 5%, buy 50 get 12%, only for
tagged wholesale customers, exclude sale items" — to become a complete pricing
rule the merchant reviews and saves, and for a margin guard that warns "this
tier sells SKU-123 below cost" before it is saved.

The thing being drafted is the thing this app exists to get right. A rule that
targets the wrong collection at the right discount is invisible until the orders
arrive; a rule that discounts below cost is invisible until the accounts do.

## Decision

### Claude never sees an id, and never returns one

The model is given the merchant's collection **titles**, group **names** and the
customer tags already in use, and answers in the same words. Turning a name into
a `gid://` is `resolveDraft`'s job, against this shop's own catalogue.

A model asked for ids will produce ones that look right. There is no way to tell
a hallucinated `gid://shopify/Collection/12345` from a real one except by
looking it up — so we look everything up, always, and a term that matches
nothing or matches two things becomes an amber chip asking which was meant.
`brand.md` §5 asks for exactly this: "every AI-returned id/SKU is validated
against the live catalog before use."

The same rule closes the tenant hole. Resolution only ever yields an id that is
in this shop's grounding, so a tampered payload naming another shop's group
resolves to nothing and reads as an unanswered question — not as a leak, and
not as an error page.

### Targeting is collections or everything; products go to the builder

The model may target `all` or `collections` only. Products and variants are
targeted by id, and a store with 10,000 products cannot have its catalogue put
in a prompt for the model to pick from. A sentence that names products drafts
against everything and says so in its notes; the merchant narrows it in the
builder, one click away with the draft filled in.

### The answer is validated by the builder's own validator

`readNamedDraft` narrows the JSON, then runs `validateRule` — the same function
the manual builder and the CSV import run. An answer that does not pass gets one
repair attempt carrying the reason, then the manual path. Nothing half-valid is
ever rendered as a rule.

Validation happens **before** name resolution, deliberately. `no_targets`
because the merchant has no collection by that name is not something a second
model call can fix; asking it to try spends twenty more seconds arriving at the
same place.

### The draft lives in the page, not in a table

The envelope — the sentence, the model's rule in names, the provenance, and the
merchant's answers to the chips — round-trips in a hidden field. A merchant
either approves the draft or leaves, and a draft they left should be gone.
Persisting every abandoned one means a retention policy, a cleanup job, and a
second place a half-made rule can be found.

Everything in the envelope is re-read defensively and re-derived on every round
trip, including the approve. It carries no more authority than the builder's own
form fields, which the same merchant could type by hand.

### The margin guard is arithmetic, not an opinion

`margin_guard` is deliberately **not** an AI feature. `guardMargins` in
`@mannon/pricing-engine` prices real variants at real costs through the same
engine checkout runs, so the warning and the price it warns about cannot
disagree — invariant 1, and appendix B's "the model never computes what a
deterministic module can".

Three things the guard does that a naive version would not:

- **Neutralises status and schedule.** A draft evaluated as-is comes back
  `not_active` for every variant, which reads as a clean bill of health. That is
  the most dangerous answer a guard can give.
- **Builds a buyer the rule applies to.** Checking a wholesale-tagged rule
  against a guest returns `audience_mismatch` everywhere, for the same reason.
- **Prices every tier break.** A rule can be healthy at 10 and underwater at 50,
  which is the exact warning the checklist asks for.

It reads unit cost from `InventoryItem`, which needs `read_inventory` —
added to the app's scopes in this phase. Without it the guard cannot say
anything at all, which is worse than saying nothing carefully.

Costs are sampled: 50 products, spread across the targeted collections. The
report carries `sampled`, and the card says the check was a sample. It never
implies it checked more than it did.

### Approving is the only write, and it records who did it

`createRule` takes an optional `SaveProvenance` whose `approvedById` is
**required** — a caller that forgets does not compile, rather than throwing in
production. The rule and its audit entry now commit in one transaction: without
it, a refused audit entry left a live pricing rule nobody was recorded as having
approved.

A rule that sells below cost needs the merchant to tick a box that says so. The
guard is re-run inside the approve request rather than trusted from the page,
because the tick refers to _this_ request's finding.

Every generated rule is logged with the prompt that made it, as the checklist
asks — in the audit entry beside the rule, not in the run log, which stays a
cost-and-latency record with no merchant text in it.

## Consequences

- Existing installs must re-authorize for `read_inventory`. Until they do, the
  guard reports "costs could not be checked" — which is what it should say.
- The composer does not stream. See `DECISIONS.md`, 2026-09-10: the admin pages
  are props-only presentational components with no client JavaScript, and
  streaming is what `streamText` exists for in the agents (4.4, 5.x), where the
  transport is already a live channel.
- Rule-from-a-sentence is not plan-gated. The free plan's one-rule limit already
  gates what can be approved, and the composer says so before drafting.

# 22. Knowing what a merchant has set up, and setting it up for them

Status: accepted (phase 4.5)

## Context

Phase 4.5 assembles Home: five KPI cards, a six-step setup checklist, a recent
activity feed, and the ✦ Claude Setup Wizard — "a 2-minute chat → Claude drafts
your customer groups, a starter pricing rule, and a registration form, shows a
preview, and applies everything on one click."

Three problems sit underneath that.

The first is that a setup checklist is a page full of **claims about the
merchant's own store**, and one of those claims — "the app embed is on" — is
something this app cannot see. Reading a theme needs the `themes` protected
scope, which Shopify grants for editing themes, not for ticking a box.

The second is that an **activity feed has two sources**. Everything a person or
an agent did is in `AuditLog`. Orders are mirrored from Shopify and are not
audited, because nobody in this app did them.

The third is that the wizard is the **widest write path in the product**: one
model answer becomes customer groups, a live pricing rule and a registration
form, on a store whose owner installed the app ten minutes ago and has no way to
tell a good rule from a ruinous one.

## Decision

### The embed is proved by the App Proxy, or attested, and the card says which

A storefront request to our App Proxy can only come from a theme that is
rendering our blocks. `withProxy` stamps `Shop.storefrontSeenAt` — at most
hourly, because the checklist wants to know _whether_, not _how often_. When it
is set, the step is done and we saw it ourselves.

Absence proves nothing: a store with no traffic this week is not a store with
the embed off. So the merchant can also say they turned it on
(`embedConfirmedAt`), and the row then reads "Your word — we haven't seen your
storefront call us yet". The moment their storefront does call, that sentence
disappears, because by then it is not their word any more.

Rejected: asking for the `themes` scope (a protected scope for a checklist is a
review conversation we would lose, and rightly); and a plain "did you turn it
on?" checkbox with no distinction between the two (invariant 4 — nothing claims
to have happened that did not, and "we can see your embed" is exactly such a
claim).

### The checklist is queries, not flags

Every other step is answered by counting rows: a rule exists, a form is live, a
buyer is approved, an order has arrived, a plan is chosen. Nothing is ticked
because a page was opened. It follows that the checklist **re-opens on its own**
when a step stops being true — which the checklist doc asks for about the embed,
and which costs nothing to apply to all six.

### The feed is a union, paginated on time

`loadActivity` reads both tables and merges them on time. Paging is by
timestamp cursor, not offset, because an offset into a merge is not a position
in either table. Each side is asked for `limit + 1` rows older than the cursor;
merging and slicing then yields exactly the rows one ordered table would have.

The one case this loses is two rows sharing a timestamp across the two tables at
a page boundary. Accepted, and row ids are prefixed (`audit:`, `order:`) so a
duplicate would render as a duplicate rather than as a React key collision.

### The wizard proposes; the front door writes

The plan comes back in a closed vocabulary — a group name and tag, one of three
rule kinds, and form fields drawn from ten keys the builder already has. A key
we do not recognise is dropped rather than rejected, because one hallucinated
field should not cost the merchant the whole plan; a rule kind we do not
recognise is rejected, because there is no safe way to guess what it meant.

Applying goes through `createGroup`, `createRule` and `createForm` — the same
functions the manual path uses. That is what makes a wizard-built rule
validated, limit-checked, published to the Function and audited exactly like one
built by hand. There is no second, looser way in, and the audit entry carries
`aiAssisted: true` with the approving staff member, which `recordAudit` refuses
to write without.

Three consequences worth naming:

- **The form is created as a draft.** Publishing decides what buyers see, and
  the wizard never showed the merchant the buyer's view.
- **A tag is never guessed.** A rule may be aimed at a group the shop already
  has, but the tag then comes from that group's row, not from the model — a
  shop that calls a group "Cafés" may tag it `wholesale-cafe`, and a rule aimed
  at `cafes` would price for nobody, silently.
- **The plan is re-read on apply.** The payload is a hidden field, so it is
  merchant-editable; `readSetupPlan` runs again, against the shop as it is at
  the moment of the click.

Rejected: applying without a preview (the whole point is that a person reads it
first); a conversational multi-turn wizard (each turn is another chance to drift
from what the merchant said, for no more information than one description
carries); and letting the wizard publish the form (see above).

## Consequences

- `Shop` gains `storefrontSeenAt`, `embedConfirmedAt` and `setupDismissedAt`.
- The App Proxy now writes, at most hourly per shop. It is a `Shop` update
  outside any transaction and cannot fail a storefront request in a way a buyer
  would see.
- A wizard run that fails part-way can leave a customer group with no rule
  behind it. Groups are created first for exactly that reason: a group with
  nothing pointing at it is inert, and the merchant can delete it.
- The wizard is gated on `merchant_agent`, like the briefing and the Ask bar, so
  a downgrade pauses it rather than deleting anything it made.

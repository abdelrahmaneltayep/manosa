# 15. Net payment terms: one module, three surfaces, no invented credit

Status: accepted (phase 3.2)

## Context

Net terms are an agreement to hand over goods now and be paid later. Three
places have to agree about them, and they are the three places a wholesale app
usually disagrees with itself:

- the **admin**, where a merchant sets terms and reads the ledger;
- **checkout**, which must offer "pay later" to exactly the right buyers;
- the **Buyer Agent** (phase 5), which will be asked "can I put this on
  account?" and has to answer the same way.

The checklist is explicit that they must: "buyer at credit limit → agent and
checkout both say so with the same number."

Shopify has no concept of net terms outside Plus B2B, which Mannon does not
require. There is no "terms" object, no invoice, and no payment method that
means "invoice me".

## Decision

### `packages/net-terms` decides; nothing else does

A third pure package, alongside the pricing engine and the order limits. It
answers four questions and imports nothing but `@mannon/pricing-engine`:

- **Whose terms apply.** A buyer's own replace their group's; they do not merge
  field by field. Net 60 from the buyer with the tier's £500 limit would be a
  third arrangement nobody wrote down.
- **May they pay later**, and if not, why — with the headroom number attached.
- **How late an invoice is**, in the bands an accountant already uses (current,
  1–15, 16–30, 30+). Inventing our own bands would reconcile against nothing.
- **What the balance is**, given partial payments and refunds.

`now` is an argument everywhere, so a ledger renders the same twice, and the
purity test forbids reading the clock.

### The payment method is the merchant's; the Function decides who sees it

A merchant sets up a manual payment method — "Net terms", or whatever they call
it — and `extensions/mannon-terms` hides it from everyone whose published terms
do not allow it, and renames it to "Pay later (Net 30)" for everyone who does.

An ineligible buyer sees **nothing**, not a disabled button. The checklist asks
for this, and it is also the only version a merchant will accept in front of
retail customers.

**This Function fails closed, and that is deliberately the opposite of the order
limits Function.** Both must never throw — a Function that throws takes the
store's checkout with it — but they differ in what "safe" means. In
`mannon-limits`, the harm is blocking a legitimate order, so an unreadable limit
is dropped and the order goes through. Here, the harm is a buyer taking goods on
credit nobody agreed to, so an error hides the method. The cost is a buyer with
genuine terms being asked to pay now, which they can email about.

### Terms travel on the buyer's existing metafield

A buyer's days, limit, balance and overdue count ride on the same
`$app:mannon.buyer` metafield the pricing Function already reads, rather than a
second one. Two metafields would be two things to keep in step, and a buyer
whose tags published but whose terms did not is a buyer priced correctly and
refused credit.

This made the publish function's `terms` field **required, not optional**.
Omitting it publishes `null`, which reads as "no terms" — so a caller that
forgot would quietly withdraw credit a merchant had granted. Making the field
required turned that into a compile error and found five existing call sites
that would have done exactly that.

### An invoice keeps the terms it was raised under

`Order.netTermsDays` and `netTermsDueAt` are stamped when the order arrives and
never re-read from the buyer. The checklist requires it — "terms changed
mid-outstanding-invoice → applies to new orders only" — and the admin says so on
the page where terms are changed, because it is the thing a merchant assumes
otherwise.

### Payments are rows, never edits

`Payment` is append-only. A correction is another row, negative if it has to be.
A ledger a merchant cannot explain line by line is one they will not take to a
debt collection. Overpayment is refused rather than absorbed: it is almost
always a typo, and a ledger that accepts one quietly stops reconciling.

## Consequences

- **The "pay later" button and the reminder email are English only.** The
  Function has no ICU and builds the name itself; the reminder ships one
  template. Editable, translatable wording is Settings § 6.2, as with the limit
  messages.
- **Nothing verifies that the merchant's manual payment method exists.** The
  Function matches by name, loosely on case and spacing, and does nothing when
  it finds no match. Checking would need a store.
- **✦ The risk signal is not built.** Scoring payment reliability is phase 4.3.
  Until then no chip is shown, rather than a guess dressed as a prediction.
- **Reminders are sent by the merchant, one click at a time**, with a
  three-day cooldown so a double-click cannot chase a buyer twice. `autoRemind`
  is stored per buyer and opt-in; the job that acts on it lands with the rest of
  the scheduled work.
- **Credit is enforced against the balance as last published.** A buyer who
  checks out twice in the same second could exceed their limit by one order.
  Shopify offers no lock at checkout, and the alternative — refusing everything
  near the limit — would cost more orders than it saves.

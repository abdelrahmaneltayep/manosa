# QA report — 3.3 · Quotes and draft orders: pipeline, expiry, accept link, price locking

Reviewed as someone who did not write it and does not trust it.

### 1. Test plan

The spec: checklist §5's "Draft orders & quotes" block — a request landing as a
card with the buyer's items and context, the New → Drafted → Sent →
Accepted/Expired states, auto-expire at 14 days with a reminder 3 days out, and
"accepted quote converts to draft order with prices locked even if rules changed
since (locked-price chip)". ✦ The suggested response and margin-floor check are
4.x and are not built.

The one question above all the others: **does the price a buyer was quoted
survive until they accept it?** Everything else serves that.

Happy paths: a merchant builds a quote, prices it from the wholesale rules,
sends it; the buyer opens the link, sees the prices, accepts; a draft order
appears in Shopify at those prices.

Invented abuse cases:

1. **Malformed input.** A quote with no lines; a quantity of zero; a send with
   no email address; a catalogue search with an empty term; a token that was
   never issued; Shopify erroring mid-search.
2. **Concurrent and repeated actions.** A buyer refreshing the accept page
   (two draft orders?); the expiry job running twice (two reminders?); adding
   the same variant twice.
3. **Wrong tenant.** Drafting, sending, accepting and expiring another shop's
   quote; another shop's quote numbering.

### 2. Automated tests

`npm test` — **1,084 tests, 57 files, all passing** (1,016 at 3.2). New:

- `tests/unit/quote-state.test.ts` (17) — every transition and every refusal,
  the expiry arithmetic across month boundaries, and the reminder firing once,
  three days out, and never on a quote that has already run out.
- `tests/integration/quotes.test.ts` (32) — pricing from the rules rather than
  the list price, the rule recorded on the line, guest and hand-typed prices,
  **the lock surviving a rule change**, the accept path doing no pricing at all,
  expiry from settings not moving when the default changes, refusing a second
  accept, the job's requeue behaviour, the token's shape, and four
  tenant-boundary cases.
- `tests/unit/quote-pages-states.test.tsx` (19) — every state below.
- `tests/e2e/public-quote.spec.ts` (6) — the buyer's page **driven in Chromium
  with JavaScript off**.

`npx playwright test` — **214 passing** (188 at 3.2).

Lint, `tsc --noEmit`, `npm run build` and `prettier --check` are clean.

### 3. State walkthrough

19 states captured to `qa/3.3/`. List: empty, all five statuses with the ✦ agent
chip, plan-gated, filtered to nothing, Arabic. Detail: a new request with the
buyer's words and their tier, drafted with the rule behind each price, a
hand-typed price, the locked-price chip with the drift banner, sent with the
buyer's link, accepted with its draft order, expired, the catalogue search with
and without results, and a refused action. Buyer's page: the live quote, expired,
already accepted, Arabic — **these four are labelled as the real page**, because
it is our own HTML on our own domain, and the e2e spec drives it for real.

Read as screenshots, not only asserted. What came out of looking: the quote list
showed "$0.00" for a request nobody had priced, which reads as free. It now says
"Not priced yet".

### 4. Cross-tenant check

Four cases, all holding: one shop's quotes never appear in another's list;
drafting, sending and accepting another shop's quote by id are all refused with
404, **and no draft order is created on the way to refusing**; the expiry job in
one shop examines none of another's; and each shop's quote numbering starts at
Q-1001 independently, so a merchant cannot infer how many other stores are on
the app. `Quote` and `QuoteLine` both carry `shop`, so the DMMF-driven guard
picks them up with no registration step.

The public accept page is the one path that reads across shops. It does so
through `withoutShopScope` with a written reason — the fourth such use — selects
by a 192-bit random token, and re-enters that shop's scope before touching
anything.

### 5. The invariants

| Rule                                           | Status at 3.3                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every price comes from the pricing engine      | Held, and this task is the sharpest test of it. Quote prices come from `resolvePrice` at draft time; a merchant's manual override is stored as one and claims no rule. Nothing else computes a price. |
| Every query is shop-scoped                     | Held, and probed above. The one cross-shop read is the public token lookup, with a written reason.                                                                                                  |
| AI drafts, a person approves                   | Held, and nothing here is AI. The ✦ section is disabled and says why.                                                                                                                              |
| Nothing claims to have happened that did not   | "Not priced yet" rather than $0.00; the send email recorded whether or not it went; the locked-price chip saying what the store would charge now without pretending it applies.                     |
| Deciding shows its working                     | Each line names the rule that priced it, or says it was priced by hand.                                                                                                                            |
| No unhandled promise rejections in the e2e run | Clean.                                                                                                                                                                                             |

### 6. Bugs found and fixed

1. **`sendQuote` took an actor and recorded nothing.** Caught by lint, of all
   things — an unused parameter. Sending a priced offer to a buyer is exactly
   the kind of event an audit log exists for, and the checklist requires the
   email too. It now does both, and records the email's outcome so a merchant
   whose provider was down can see what was attempted.

2. **A request nobody had priced showed "$0.00"**, which reads as free rather
   than as not-yet-priced. Found by looking at the list capture. It now says so.

3. **The public route carried a pointless `useTranslationSafe` indirection**
   with an eslint-disable on it — written on the way to something and left
   behind. Replaced with a plain import.

4. **`parseAmount`-style hardcoding, avoided rather than fixed:** the quote's
   `listPrice` comes in as a decimal string from Shopify and goes through the
   engine's `parseMoney`, so a three-decimal currency is right. Called out here
   because 3.2 shipped that same shape wrong and it was worth checking twice.

Two more were in tests rather than the code: the quote fixtures installed a
`pro` shop when `draft_orders` unlocks on `growth` (the gate was right), and the
fake admin did not answer the discount-Function query that `createRule`
publishes through.

### 7. Open items

- **Still not seen in a real Shopify admin**, now across seven phases.
- **`originalUnitPriceWithCurrency` is unverified.** It is Shopify's documented
  way to override a draft order line's price, and the test asserts the exact
  field and value we send, but no draft order has ever been created against a
  real store. **If Shopify rejects that field, the price lock fails at the last
  step** — the quote would still say $6.50 and the draft order would charge
  $9.00. This is the single most important thing to check on a dev store.
- **The catalogue search is unverified.** `productVariants(query:)` with a
  wildcard on title and SKU is asserted against a fake. Whether that query
  syntax returns what a merchant expects needs a store with products in it.
- **A quote is priced as one order.** Cart-value rules see the line's own
  extended total, because a quote has no cart. A merchant whose rules key off a
  whole-basket subtotal will find a quote priced per line.
- **✦ The suggested response and margin-floor check are not built** (4.x). The
  section is on the page, disabled, and says so.
- **No quantity editing on an existing line.** A merchant changes a quantity by
  removing the line and adding it again. A quantity field per row is the obvious
  next increment; it was left out rather than shipped half-wired.
- **Quotes carry no shipping, tax or discount codes**, by design — those are
  settled on the draft order in Shopify.
- **The quote emails are English only**, like the reminder and the limit
  messages. Editable, translatable wording is Settings § 6.2.
- **`Quote` and `QuoteLine` rows are never pruned.** Retention lands in 7.2.

# QA report — 3.2 · Net payment terms: eligibility, pay later, ledger, reminders

Reviewed as someone who did not write it and does not trust it.

### 1. Test plan

The spec: checklist §5's "Net payment terms" block — setup per group or per
customer with an "overridden" chip, the pay-later button at checkout, the ledger
with aging buckets and reminders, and four named edge cases. ✦ The risk signal is
4.3 and is not built; no chip is shown rather than a guess.

Happy paths: a merchant gives a tier Net 30; a buyer in it checks out and the
order becomes an invoice with a due date; the merchant records a bank transfer
against it; the invoice settles and drops off the ledger; a buyer past their
credit limit stops being offered credit at checkout.

Invented abuse cases:

1. **Malformed input.** An amount that is not a number; more decimal places than
   the currency has; a payment of zero; a payment larger than the balance; "Net
   0" and "Net -5"; buyer facts that are not JSON; an empty payment-method name.
2. **Concurrent and repeated actions.** The same reminder clicked twice; the
   same order webhook delivered twice; terms changed while an invoice is open.
3. **Wrong tenant.** Recording a payment against another shop's order, reminding
   another shop's buyer, reading another shop's ledger and settings.

### 2. Automated tests

`npm test` — **1,016 tests, 54 files, all passing** (908 at 3.1). New:

- `packages/net-terms` (46) — the customer-over-group rule and its refusal to
  merge, credit-limit arithmetic at and over the boundary, never-negative
  headroom, refusing to compare two currencies, the aging bands (including that
  an invoice due today is current, not a day late), balances with partial
  payments and overpayments, defensive parsing of both metafields, and the
  purity guard.
- `extensions/mannon-terms` (17) — who sees the method, the rename, matching the
  merchant's own method name loosely, and six cases proving it never throws and
  hides on error.
- `tests/integration/terms.test.ts` (34) — terms resolution against real rows,
  publishing on every change, stamping an invoice at checkout, part and full
  payments, the ledger's totals and pagination, reminders and their cooldown,
  the settings publish, the plan gate on all four write paths, and four
  tenant-boundary cases.
- `tests/unit/orders-pages-states.test.tsx` (+11) — every ledger state below.

`npx playwright test` — **188 passing** (177 at 3.1).

Lint, `tsc --noEmit`, `npm run build` and `prettier --check` are clean.

### 3. State walkthrough

11 states captured to `qa/3.2/`: nobody on terms yet, everything paid (a
different state, and the page says so), the aging bands with overdue money in
red, rows with a part payment and a recent reminder, a refused payment beside
the field that caused it, settings not yet published, plan-gated, the settings
form with its live button preview, a settings error, and Arabic.

Read as screenshots, not only asserted. Two things came out of looking:

- Every badge rendered identically in the capture harness, so **"overdue rows
  red" was not verifiable from a capture at all**. The harness now styles badge
  tones, which is why `terms-aging.png` shows the red figures.
- The pay-later preview read "Pay later (Net 30)" for every store. Now it takes
  the days from a term the store actually uses.

### 4. Cross-tenant check

Four cases, all holding: another shop's ledger is empty and its total is zero;
recording a payment against another shop's order is refused with 404 **and the
order is unchanged afterwards**; reminding another shop's buyer is 404;
one shop's payment-method name never appears in another's settings. `Payment`
carries `shop`, so the DMMF-driven guard picks it up with no registration step.

### 5. The invariants

| Rule                                           | Status at 3.2                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every price comes from the pricing engine      | Held. Nothing here is a price: balances are Shopify's totals less refunds and payments, all as `Money` from the engine, and `parseAmount` uses `parseMoney` so each currency's exponent is right. |
| Every query is shop-scoped                     | Held, and probed above.                                                                                                                                                              |
| AI drafts, a person approves                   | Held, and nothing here is AI. Reminders are sent by the merchant; ✦ drafting them is 4.3.                                                                                             |
| Nothing claims to have happened that did not   | The "checkout has not been told" banner, the reminder recorded even when the provider fails, and the part-payment line rather than a paid/unpaid flag.                                |
| Deciding shows its working                     | The buyer page names their terms, whether they are overridden, what the group's were, and what they owe — all from the same module the Function asks.                                 |
| No unhandled promise rejections in the e2e run | Clean.                                                                                                                                                                               |

### 6. Bugs found and fixed

1. **Five call sites would have silently withdrawn a buyer's credit.** Adding
   `terms` to the buyer metafield as an *optional* field meant every existing
   caller of `publishBuyerFacts` — a group change, a tag sweep, an approval, an
   undo, the customer backfill — published `terms: null`, which checkout reads
   as "no terms". A merchant who edited a buyer's tags would have found their
   credit gone with no trace. Making the field **required** turned it into a
   compile error, which found all five; each now goes through
   `publishBuyerTerms`.

2. **The payment-customization Function failed open.** Its catch returned "no
   changes", which leaves the pay-later method visible to every retail
   customer — a stranger could have taken goods without paying. It now hides the
   method on error instead. Checkout still completes; the worst case is a
   genuine buyer asked to pay now. Written up in `docs/adr/0015` because it is
   deliberately the opposite of what the order-limits Function does.

3. **`parseAmount` hardcoded a two-decimal subunit** and carried a dead
   `void formatted` line pretending otherwise. It would have read "12.500" KWD
   as 1250 fils instead of 12500 — a factor of ten, in half this app's market.
   Replaced with the engine's `parseMoney`, and covered by a test that includes
   KWD and JPY.

4. **The checkout preview claimed "Net 30" for every store**, including one
   whose buyers are all on Net 60.

5. **The stand-in capture harness rendered every badge identically**, so the
   checklist's "overdue rows red" could not be checked from a screenshot. Fixed
   in the harness, which improves every future capture too.

One more was in a test rather than the code: the terms fixtures installed a
`pro` shop, but `net_terms` unlocks on `growth` — the gate was right and the
test was wrong, which is the good direction for that to fail in.

### 7. Open items

- **Still not seen in a real Shopify admin**, now across six phases.
- **The payment Function has never run at a real checkout.** In particular:
  whether the app-reserved buyer metafield is readable from
  `purchase.payment-customization.run`, and whether a merchant's manual payment
  method appears in `paymentMethods` under the name they gave it. The Function
  does nothing when it finds no match, so the failure mode is "the method is
  shown to everyone", which a merchant can see.
- **Nothing checks that the manual payment method exists.** A merchant who
  mistypes the name gets a method shown to everybody, with no warning. Detecting
  it needs a store.
- **The pay-later button and the reminder email are English only.** The Function
  has no ICU and builds the name itself; the reminder ships one template.
  Editable, translatable wording is Settings § 6.2, with the limit messages.
- **`autoRemind` is stored and read by nothing yet.** The opt-in exists per
  buyer; the job that acts on it is not built, so every reminder is sent by a
  merchant clicking a button. That is the checklist's default anyway.
- **✦ The risk signal is not built** (4.3). No chip is shown.
- **A race at the credit limit.** Two checkouts in the same second are both
  measured against the balance as last published, so a buyer could exceed their
  limit by one order. Shopify offers no lock at checkout; refusing everything
  near the limit would cost more orders than it saves.
- **Partial payments are recorded but never reconciled against Shopify.** If a
  merchant marks the order paid in Shopify's admin instead, `orders/updated`
  sets `financialStatus: paid` but `amountPaid` stays where it was. The ledger
  drops the invoice (it reads `paidAt`), so the merchant sees the right thing —
  but the two numbers disagree in the row.
- **`Payment` rows are never pruned.** Retention lands in 7.2. Arguably these
  should be kept longer than everything else; that decision belongs with 7.2.

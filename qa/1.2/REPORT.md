# QA report — 1.2 · Shopify discount Function wired to the engine


**Verdict: pass with one blocking open item.** The Function, the ruleset
publisher and the buyer-facts sync are implemented and green. The task's own
acceptance criterion — "cart/checkout applies the correct wholesale price for a
tagged customer on the dev store" — **has not been met**, because it cannot be
met from this environment. Everything up to that point is verified; §7 says
exactly what remains.

### 1. Test plan

_Happy paths_

- A tagged buyer's cart line is discounted to the engine's price.
- The discount is per unit, so quantity multiplies exactly.
- Each line prices independently; volume tiers use the line's own quantity;
  cart-value rules use the cart subtotal.
- Collection targeting and B2B company audiences resolve from the metafields
  the app publishes.
- Publishing creates the discount once, attaches the ruleset, and skips an
  unchanged ruleset.

_States_

- No ruleset published; discount class not PRODUCT; corrupt ruleset; one
  malformed rule among good ones; a line that is not a product variant; a rule
  that would raise the price; a cart-value rule priced in another currency.

_Three invented abuse cases_

1. **Malformed input** — a ruleset that is not JSON, one with a future format
   version, one whose `rules` is a string, a rule with a non-integer money
   amount, and a rule of an unknown kind. None may throw: see §5.
2. **Concurrency** — the publisher racing itself. Covered by the hash check
   (an unchanged ruleset is a no-op) and by asserting a second publish does not
   create a second discount.
3. **Wrong shop/tenant** — publishing for one shop must not set another's
   discount id or ruleset hash.

### 2. Automated tests

`npm test` — **337 passed** (24 files), up from 281. This task adds 56:

| Suite                                         | Cases | Covers                                                                                                                                            |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/mannon-discount/test/run.test.ts` | 22    | Checkout behaviour end to end, agreement with the engine, and every failure mode                                                                  |
| `packages/pricing-engine/test/codec.test.ts`  | 16    | Wire-format round trip, identical pricing before and after, and eight ways of being handed a damaged ruleset                                      |
| `tests/integration/ruleset-publish.test.ts`   | 18    | The exact mutations and variables sent, discount reuse, hash skip, size refusal, Shopify's own errors, tenant isolation, buyer-fact normalisation |

A Shopify Function is a plain `(input) => output`; the CLI only wraps it in
WebAssembly. So the checkout logic is fully exercised here without a store —
what is _not_ exercised is the WASM build, the deploy, and the Admin API
accepting our mutations.

Because those mutations cannot be run without a store, the publisher tests pin
**the request** — mutation name, variables, metafield owner, namespace, key and
type — rather than a response we made up. That is the strongest guarantee
available before the dev-store run, and it will catch an accidental change to
what we send.

The API shapes were taken from Shopify's own published function examples and
sample app rather than from memory.

### 3. State walkthrough

No UI in this task. The Function's observable states are its outputs, and all
22 are asserted exactly. The Pricing page's states arrive with 1.3.

### 4. Cross-tenant check

- Publishing for one shop leaves another's `discountId` and `rulesetHash` null.
- All publisher reads and writes go through the scoped client, so a missing
  tenant throws rather than reading across shops.
- At checkout the boundary is Shopify's: a Function only ever sees one shop's
  discount, and the ruleset it reads is the metafield on that shop's own
  discount node.

### 5. The three musts

| Rule                                           | Status at 1.2                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | **Now load-bearing, and held.** The Function computes nothing: it builds a context per cart line and calls `resolvePrice`. A dedicated suite asserts that what the Function charges equals what the engine returns across percentage, fixed-price, stacked and rounding cases — the property that lets the Buyer Agent quote a price it can stand behind. |
| No AI mutation without an approval record      | Unchanged; no AI call sites yet.                                                                                                                                                                                                                                                                                                                          |
| No unhandled promise rejections in the e2e run | Unchanged and clean. The Function is synchronous and cannot reject; it also cannot throw, by design (§6).                                                                                                                                                                                                                                                 |

### 6. Design decisions worth calling out

- **The Function never throws.** One that fails applies no discounts at all, so
  every wholesale buyer in the store quietly pays retail until a human notices.
  Parsing never throws, the entry point catches everything, and one malformed
  rule costs that rule alone. Wrong-but-visible beats wrong-but-silent, and the
  shelf price is the visible failure.
- **Market-scoped rules are dropped at checkout, deliberately.** The Function
  knows the buyer's country but not which Shopify Market it maps to, and an
  `exclude` rule evaluated with no market id would match everywhere and hand out
  a discount the merchant had scoped away. Dropping is the safe direction; the
  Function warns, and 1.3 publishes the map.
- **An oversized ruleset fails rather than truncating.** Shopify caps a
  metafield, and a truncated ruleset means charging prices nobody configured.
  The publisher refuses over 48 KB and leaves the last good ruleset live.

### 7. Open items

- **BLOCKING for this task: the dev-store run has not happened.** Needed on
  `mannon-9iu9ewku.myshopify.com`, in this order: `shopify app deploy` to build
  and ship the Function; confirm the automatic discount appears; tag a customer
  `wholesale`; add the product to a cart as that customer; confirm checkout
  charges the engine's price. Until then the WASM build, the two Admin API
  mutations, and the metafield reads in the input query are unproven. This is
  the same gate as the Phase 0 walkthrough and needs the same session.
- **Nothing calls `publishRuleset` yet.** There is no rules table until 1.3, so
  the publisher has no trigger. Recorded in PROGRESS.md as a hard dependency:
  1.3 must call it after every rule save, or a saved rule will not exist at
  checkout.
- **Product collection metafields are not published yet.** Collection-targeted
  rules therefore will not apply at checkout even though the engine handles
  them and the admin will show them applying. Also a recorded 1.3 dependency —
  it needs a `products/update` handler and a backfill, which belongs with the
  task that lets merchants create such rules.
- **Correction to the record:** while updating PROGRESS.md this task I found
  that the 0.2 and 0.3 status rows had never actually been updated — two
  scripted edits failed silently against a Prettier-reformatted table and I did
  not verify them at the time. PROGRESS.md had been reporting 0.2 as not started
  and 0.3 as blocked for two commits. Corrected here.

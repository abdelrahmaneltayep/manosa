# QA report — 1.1 · `packages/pricing-engine`


**Verdict: pass.** No open items on the engine itself. Nothing consumes it yet
by design — 1.2 wires the Shopify Function, 1.3 the Pricing page — so the "no
price from outside the engine" rule has nothing to enforce against until then.

### 1. Test plan

The task specifies golden vectors written from the spec's examples **before** the
implementation. That is what was done: 40 vectors first, then the resolver, then
one more vector added and corrected (§6).

_Happy paths, taken from the spec rather than invented_

- The three demo-store personas (§11): 35% storewide, individual variant price,
  volume tiers.
- "Buy 10 get 5%, buy 50 get 12%, only for tagged wholesale customers, exclude
  sale items" (§2 rule-from-a-sentence), at 100 units and on a sale item.
- "Give VIP customers 20% off the new collection until Friday" (§1 Ask Mannon),
  before, during and after the window.
- "What's my price for SKU-450 at 100 units?" (§6) — the Buyer Agent's most
  common question.
- "Add 1 more unit to unlock the 12% tier" (§6 tier-aware upsell).

_States and edges_

- Guest, logged-in-but-untagged, named customer, customer group, B2B company.
- Draft and archived rules; scheduled rules outside their window.
- Market include and exclude; a currency the rule has no price in; a currency it
  does.
- Cart-value tiers above, below, and with no cart at all.
- Cascade precedence; priority order; equal priority; stacking; a
  non-combinable winner; a non-combinable follower; the floor at zero.
- Rounding to the cent, and rounding once rather than per rule.

_Three invented abuse cases_

1. **Malformed input** — percentages outside 0–100, negative amounts, tiers
   whose minimum exceeds their maximum, a quantity of zero or negative, decimal
   strings with more precision than the currency allows, and `"1,000.00"`.
2. **Concurrency** — not applicable in the usual sense (the module is pure), so
   the equivalent was tested instead: the same input resolved twice must be
   identical, and rules arriving in a different order must not change the price.
   Both are property tests over 500 generated cases.
3. **Wrong customer** — a rule scoped to one named customer must never price for
   another. This is the worst bug this engine could have, so it is a vector of
   its own (`another-customer-does-not-get-that-rate`), not just a property.

### 2. Automated tests

`npm test` — **281 passed** (21 files), up from 193. The engine contributes 88:

| Suite                     | Cases | Covers                                                                                                                                                                                              |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/golden.test.ts`     | 41    | Every golden vector, each citing its spec source and what it protects                                                                                                                               |
| `test/properties.test.ts` | 10    | Never negative, always whole minor units, order-independent, deterministic, every rule traced with a reason, inactive rules inert, irrelevant rules harmless, line total consistent, quantity guard |
| `test/money.test.ts`      | 17    | Round-tripping, JPY (0dp) and KWD (3dp), padding, precision refusal, junk input, exact addition, the four rounding modes, refusal to mix currencies                                                 |
| `test/validate.test.ts`   | 15    | Every validation the checklist names, including the "10–49 overlaps 40–60" message, plus the margin guard's arithmetic                                                                              |
| `test/purity.test.ts`     | 5     | No foreign imports, no dynamic import or require, no dependencies, no clock or randomness                                                                                                           |

Lint, root typecheck, standalone package typecheck and build all clean.

The property tests run 500 generated cases each for the invariants that matter
most. The purity suite exists because portability is a promise the engine makes
to four other subsystems, and it would otherwise be discovered broken at deploy
time.

### 3. State walkthrough

Not applicable: this task ships no UI. The engine's observable states are its
resolutions, and all 41 are asserted exactly rather than screenshotted. The
Pricing page's states arrive with 1.3.

### 4. Cross-tenant check

The engine holds no data and reads no database, so there is nothing to leak
across shops — it prices only what the caller hands it. The tenant boundary
stays where it is: the caller loads rules through the shop-scoped client.

The equivalent risk at this layer is **cross-customer** leakage, which is
covered: a rule scoped to one named customer, one group, one company or one tag
must not price for anyone else. Six vectors and one property cover it.

### 5. The three musts

| Rule                                                              | Status at 1.1                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price on any surface that did not come from the pricing engine | **The engine now exists**, and nothing displays a price yet, so the rule holds trivially and starts being enforceable at 1.2. `marginFor()` lives here too, so a "sells below cost" warning and the price it warns about read from the same resolution. |
| No AI mutation without an approval record                         | Unchanged; still no AI call sites. Rule-from-a-sentence (4.2) will produce `PricingRule` objects that go through `validateRule()` before a merchant is shown them.                                                                                      |
| No unhandled promise rejections in the e2e run                    | Unchanged and still clean; the engine is synchronous and returns no promises at all.                                                                                                                                                                    |

### 6. Bugs found and fixed

Both were in the **vectors**, and both were found by checking my own arithmetic
rather than by the code disagreeing with me — which is the point of writing them
first.

1. **A clamp case that never clamped.** `stacking-clamps-at-zero-and-says-so`
   applied $2 off, then 60%, then 50% to a $10 item and expected $0.00. That
   lands at $1.60. Had it gone in as written, the resolver would have been
   changed to satisfy a wrong expectation. Replaced with a discount larger than
   the price, which reaches the floor honestly.

2. **A stacking case that tested the previous case again.** The case meant to
   cover "combinable winner, non-combinable follower" paired a combinable rule
   at priority 200 with a non-combinable one at priority 90 — so the
   non-combinable rule won and it re-tested the case above it. Caught by the
   only vector that failed on the first run; the engine was right and the vector
   was wrong. Fixed by giving the non-combinable rule a lower priority.

A third correction was to a reason code rather than a behaviour: six vectors
used `outranked`, which cannot happen under the combination model — a rule after
the winner stops because the winner forbids stacking, and saying so is more use
to the merchant reading "Why this price?". Renamed to
`not_combinable_with_winner`.

### 7. Open items

- **Nothing consumes the engine yet.** By design: 1.2 wires the Shopify discount
  Function, 1.3 the Pricing page and preview. Until then the engine is verified
  but unproven against a real checkout, which is exactly what 1.2 is for.
- **Persistence is not modelled yet.** `PricingRule` is the in-memory shape; the
  Prisma table and the mapping to it land with 1.3. The shapes are deliberately
  plain objects so that mapping is a translation, not a redesign.
- **Rule ids in vectors are synthetic.** Once rules are persisted, the golden
  vectors keep their own ids; they test the resolver, not the repository.

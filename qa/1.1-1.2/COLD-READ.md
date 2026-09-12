# Cold read — 1.1 `packages/pricing-engine` and 1.2 the discount Function

**Reviewer:** independent QA pass, no involvement in writing this code.
**Date:** 2026-09-12
**Scope:** `packages/pricing-engine/**`, `extensions/mannon-discount/**`,
`app/lib/pricing/**`, plus every other caller of `resolvePrice` /
`priceLine`, because Invariant 1 is about all of them agreeing.

## Verdict

**FAIL.**

Four P0s. The worst two are the same root cause in two directions: **nothing
teaches the checkout Function which collections a product is in until that
product happens to be edited, and nothing teaches the storefront/quote/agent
path at all.** A merchant who writes the most ordinary wholesale rule there is
— _"20% off everything except Sale items"_ — gets 20% off their sale items at
checkout on their entire pre-existing catalogue, and a buyer who reads the
quick-order table is shown £8.00 and charged £10.00 for the same line.

The engine itself is careful, well-documented work and its arithmetic is
integer nearly everywhere. It fails on the one place it is not (percentage
multiplication in float, 12,096 demonstrated one-cent errors, every one of
them against the merchant) and on the fact that its callers hand it an
_incomplete context_ — so "one module" still produces four different answers
for the same buyer and the same line.

## What I ran

| Command                                                                        | Result                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `npx vitest run` (whole suite, `TEST_DATABASE_URL=…mannon_cr1`)                 | **125 files, 2253 tests, all green**, 173s      |
| `npm run typecheck`                                                            | clean (including my probe files)                |
| `npm run lint`                                                                 | 1 error — in `qa/0.1/cold-read/probe.test.ts`, an **untracked** file from a parallel review, not this task's code. My probes lint clean. |
| `npx prettier --check qa/1.1-1.2/cold-read`                                     | clean                                           |
| `npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts`                 | **14 failed / 4 passed** — the failures are the findings below |

Working tree note: `app/lib/pricing/admin-graphql.server.ts` and
`app/routes/healthz.ready.tsx` carry uncommitted changes from another
in-flight review (GraphQL throttle retries). I reviewed the committed code and
ignored that diff.

Every finding below has a runnable demonstration in `qa/1.1-1.2/cold-read/`.
Run them all with:

```bash
export TEST_DATABASE_URL='postgresql://mannon:mannon@localhost:5432/mannon_cr1?schema=public'
npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
```

A failing probe **is** the finding; each file says which one.

---

# P0 — a buyer is charged the wrong amount, or a merchant sells below intent

### P0-1 Collection membership is never backfilled, so collection rules are wrong at checkout for the whole existing catalogue

**Where:** `app/lib/pricing/product-facts.server.ts` (the only writer),
`app/lib/jobs/registry.ts:20-35` (no product backfill job),
`app/lib/webhooks/handlers/products-update.server.ts:30`,
`app/lib/webhooks/handlers/collections-update.server.ts:67`.

`$app:mannon.collections` is written **only** by `products/update` and
`collections/update`. There is a `customers.backfill` job and an
`orders.backfill` job; there is no products backfill. So on a store that
installs Mannon with 10,000 existing products, every one of them arrives at
checkout with `collections: null` until somebody edits it in Shopify admin.

`eligibilityReason` then sees `collectionIds: []`, which means:

- a rule **targeting** a collection matches nothing — the buyer pays retail;
- a rule **excluding** a collection excludes nothing — **the buyer gets the
  wholesale discount on exactly the products the merchant protected.**

The second direction is the money one. "20% off everything except Sale items"
is the canonical wholesale rule; ADR 0007 even lists collection membership as
"phase 1.3" and the vector file has a case for it
(`rule-from-a-sentence-excludes-sale-items`). The vector passes because the
harness hands the engine a product fixture with `collectionIds: ["c-sale"]` —
a value the production pipeline cannot produce for an un-edited product.

**Verified:** `qa/1.1-1.2/cold-read/storefront-vs-checkout.test.ts` → _"a
product whose `$app:mannon.collections` metafield was never written … is still
excluded from a rule that excludes its collection"_ — fails; the Function
issues the discount.

**Fix direction:** a `products.backfill` job queued from `ensureShop`, paging
like the customers one, plus a merchant-visible "N products not yet published
to checkout" state. Until then, no collection-targeted rule is safe to
activate.

---

### P0-2 The buyer is shown one price and charged another: every non-checkout surface prices with no collections

**Where:** `app/lib/quotes/pricing.server.ts:74` — `collectionIds: []`,
hardcoded, in the single function that prices the quick-order block
(`app/lib/storefront/quick-order.server.ts:216`), quotes
(`app/lib/quotes/pricing.server.ts:114`), the Buyer Agent
(`app/lib/agent/buyer/tools.server.ts:255`) and PO-to-order
(`app/lib/orders/purchase-order.server.ts:191`). The SKU lookup query
(`quick-order.server.ts:20`) does not even fetch collections.

So for the same rule, the same buyer and the same SKU:

| Surface                             | `collectionIds` it passes the engine        |
| ----------------------------------- | ------------------------------------------- |
| checkout Function                    | from the product metafield (when published) |
| quick order / quote / Buyer Agent / PO | **always `[]`**                           |
| admin preview (`previewFor`)         | the rule's own target list                  |
| "Why this price?" (`explainFor`)     | **always `[]`**                             |

Concretely, with "20% off everything except Sale" and a sale item: the
quick-order block shows **$8.00**, checkout charges **$10.00**. The buyer is
shown a price they will not get. In the other direction, a quote — which
`pricing.server.ts` documents as _"a promise … the engine is asked once and
what it said is stored"_ — **locks the wrong number forever**, and the buyer is
charged it.

**Verified:** `qa/1.1-1.2/cold-read/storefront-vs-checkout.test.ts` → _"a sale
item, for a wholesale buyer / is shown and charged the same price"_:
`{ shown: 800, charged: 1000 }`.

---

### P0-3 One unparsable money string kills the discount for the whole cart — and a zero-decimal-currency store is permanently in that state

**Where:** `extensions/mannon-discount/src/cart_lines_discounts_generate_run.ts:131`
(`readSubtotal` → `parseMoney`) and `:148` (`basePrice` → `parseMoney`), under
the single top-level `try` at `:36`.

`parseMoney` deliberately **throws** when a decimal has more precision than the
currency allows (`money.ts:78-88`, and `money.test.ts:46` pins that behaviour).
The Function feeds it Shopify's own `MoneyV2.amount` strings without
normalising them. Two consequences:

1. **Zero-decimal currencies.** Shopify serialises `MoneyV2.amount` with a
   trailing decimal (`"1000.0"`). For JPY/KRW/VND/ISK/CLP/etc.
   `currencyExponent` is `0`, so `"1000.0"` has "more precision than JPY
   allows" → throw → the catch at `:38` returns `NOTHING` → **every wholesale
   buyer in that store pays retail, forever, silently.** The only trace is a
   `console.error` nobody reads.
2. **One bad line costs the cart.** `discountFor` is called inside the loop but
   is not individually guarded, so a single line with an odd amount removes the
   discount from every other line. The file's own header promises the
   opposite: _"Anything unexpected costs one line, not the cart."_ (`:31`).

**Verified:** `qa/1.1-1.2/cold-read/function-money.test.ts` — both tests fail;
the first (`parseMoney("1000.0","JPY")` throws) passes, which is the mechanism.

**Note on confidence:** I could not query `shopify.dev` from this environment to
pin the exact serialisation, so treat the JPY half as "must be checked on a
dev store before release" — but the sub-cent half is unconditional and
demonstrated.

---

### P0-4 The automatic discount is created without `discountClasses`, and the Function refuses to do anything without `PRODUCT`

**Where:** `app/lib/pricing/ruleset.server.ts:36-48` (`CREATE_DISCOUNT`) and
`:161-192` — the `DiscountAutomaticAppInput` carries `functionId`, `title`,
`startsAt`, `combinesWith` and `metafields`, and **no `discountClasses`**.
The Function's first statement is
`if (!input.discount.discountClasses.includes("PRODUCT")) return NOTHING;`
(`cart_lines_discounts_generate_run.ts:48`).

`discountClasses` is set nowhere in the repo (grep: only the Function and its
own test, which hard-codes `["PRODUCT"]` into the fixture). On API version
`2025-07` — declared in `extensions/mannon-discount/shopify.extension.toml:6` —
an app discount driving `cart.lines.discounts.generate.run` gets its classes
from that input. Either Shopify rejects the create (loud failure, no wholesale
pricing at all) or it creates a discount with no product class (silent failure,
the Function returns nothing on every cart). Both are "no wholesale price ever
reaches a buyer".

The integration test `tests/integration/ruleset-publish.test.ts:106-120`
asserts the mutation variables field by field — and asserts only the fields
that are there, so it pins the omission rather than catching it.

**Cannot be verified from here** (no egress to `shopify.dev`, no dev store).
It is the single highest-value thing to check on a real store, and it is a
one-line check: create the discount, then query
`discountNode { discount { ... on DiscountAutomaticApp { discountClasses } } }`.

---

# P1 — broken feature, or the admin and checkout disagree

### P1-5 Percentage rules round the wrong way, always against the merchant

**Where:** `packages/pricing-engine/src/resolve.ts:84` —
`{ type: "multiply", factor: (100 - percentage) / 100 }` and `:153`
`state.fractional *= effect.factor`.

`money.ts:5` states: _"No price arithmetic anywhere in this package touches a
floating-point value."_ It does, here. Because the product is computed in
binary floating point, every case whose exact value lands on a half-cent tie
lands just **below** it, and `half_up` — which `money.ts:175` says is chosen
because it is _"what a merchant checking the arithmetic by hand expects"_ —
rounds it down.

The plainest example: **$10.75 with 6% off.** Exact: `10.75 × 0.94 = 10.105` …
in minor units `1075 × 94 / 100 = 1010.5`, half-up **1011** = $10.11. The
engine returns **1010** = $10.10. A cent per unit, in the buyer's favour, on
every line, for ever.

Scale of it, measured:

- whole-number percentages 1–99 × prices $0.01–$2,000.00 (19.8M cases):
  **12,096 wrong**, every one a cent low.
- two-decimal percentages 0.01–99.99 × prices $0.01–$20.00 (20M cases):
  **1,540 wrong**, same direction.

**Verified:** `qa/1.1-1.2/cold-read/rounding.test.ts` and
`rounding-integer-pct.test.ts` (each ~23s; they brute-force against exact
integer arithmetic).

**Fix direction:** keep percentages in hundredths and do
`price × (10000 − pctHundredths)` in integers, dividing once at the rounding
step. `roundMinorUnits` then takes a numerator/denominator rather than a float.

---

### P1-6 "Why this price?" is not the checkout answer, and the route says it is

**Where:** `app/lib/pricing/view-model.server.ts:293-318`;
`app/routes/app.pricing.settings.tsx:81` — _"The real engine over the real
rules: this answer is the checkout answer."_

`explainFor` builds a context with `groupIds: []`, `companyId: null`,
`collectionIds: []`, `productId = variantId`, `marketId: ""` and
`cartSubtotal: price` — the **unit** price, not `price × quantity`. So the
merchant's own audit tool answers wrongly for:

- every **group**-targeted rule → always `audience_mismatch`;
- every **company**-targeted rule → always `audience_mismatch`;
- every **collection**-targeted or collection-**excluded** rule;
- every **product**-targeted rule (the form only asks for a variant id);
- every **cart-value** rule at any quantity above 1 — 50 units at $30.00 is a
  $1,500 line at checkout and a "$30.00 cart" here, so a $1,000 threshold
  reports `no_matching_tier` while checkout applies it.

That is four of six audience modes and two of four targeting modes. Invariant 5
("deciding shows its working") is the one this feature exists to satisfy.

**Verified:** `qa/1.1-1.2/cold-read/why-this-price.test.ts` — both fail.

---

### P1-7 Schedules are a day early, and the shop's timezone is never used

**Where:** `app/lib/pricing/rule-form.server.ts:44-49` (`asDate` →
`new Date("2026-07-01")` = UTC midnight), `view-model.server.ts:121`
(`forDateInput` → date only), `packages/pricing-engine/src/eligibility.ts:19-25`.

The builder's fields are `s-date-field` (`RuleBuilderPage.tsx:412,418`) — day
granularity. A merchant who sets "ends 1 July" gets a rule that dies at
`2026-07-01T00:00:00Z`, i.e. **dead for the whole of the day they named.**
And nothing anywhere converts to `Shop.ianaTimezone` (which exists, is
populated, and is respected by every analytics surface —
`app/lib/analytics/series.server.ts:10`). In a US-Pacific store a rule that
starts "1 July" goes live at **18:00 on 30 June, store time**.

Checkout is where this is charged, and the merchant has no way to express what
they meant.

**Verified:** `qa/1.1-1.2/cold-read/schedule.test.ts` — first two tests.

---

### P1-8 A later combinable rule overwrites a negotiated contract price — upward

**Where:** `packages/pricing-engine/src/resolve.ts:32-38` (`CLASS_RANK`),
`:144-155` (`applyEffect`, `case "set"`).

The cascade comment promises: _"a negotiated contract price is a promise, and a
percentage rule must not quietly undercut or override it."_ But `set` is
unconditional. A combinable `fixed_price` of **$80.00** followed by a
combinable `cart_value_tier` whose tier is `fixed_price $90.00` resolves to
**$90.00** — the contract price is overwritten by a higher one, and the trace
reports **both rules as applied**, so "Why this price?" shows the contract
applying and then being undone.

Any `set`-shaped rule of a later class (`volume_tier` fixed price,
`cart_value_tier` fixed price) does this to any earlier one.

**Verified:** `qa/1.1-1.2/cold-read/cascade.test.ts` → _"never charges more
than the contract price"_: got `unitPrice: 9000`, `applied: ["contract",
"cart-tier"]`.

---

### P1-9 A rule that raises a price is honoured everywhere except checkout, silently

**Where:** `app/lib/pricing/view-model.server.ts:242-289` (`previewFor`),
`extensions/mannon-discount/src/cart_lines_discounts_generate_run.ts:171-175`.

A `fixed_price` of $120.00 on a $100.00 item: the builder's live preview says
**"now $120.00"**, the quote locks $120.00, the Buyer Agent quotes $120.00 —
and the Function computes `perUnitDiscount = -2000`, returns `null`, and
checkout charges **$100.00**. ADR 0007 documents the Function's side of this as
deliberate; nothing documents it to the merchant, nothing validates against it,
and nothing warns in the builder where the preview is actively telling them the
opposite.

**Verified:** `qa/1.1-1.2/cold-read/cascade.test.ts` → _"is shown in the admin
preview exactly as checkout will charge it"_: preview `$120.00`, charged
`$100.00`.

---

### P1-10 Market scoping: specified, modelled, tested by golden vectors — and unreachable

**Where:** `docs/spec/pages-features.md:53` ("Markets: apply/exclude Shopify
Markets, multi-currency price lists"); `types.ts:113` (`MarketScope`);
`eligibility.ts:82-93`; three golden vectors; `rule-form.server.ts:77-80`.

- No market fields exist in the builder UI (`RuleBuilderPage.tsx` — grep for
  "market" returns nothing), so `parseMarkets` always reads the default `"all"`.
- CSV import (`csv/plan.ts:179`), the AI draft path
  (`rule-from-sentence.server.ts:376`) and the setup wizard
  (`wizard.server.ts:115`) all hardcode `{ mode: "all", marketIds: [] }`.
- The Function drops anything else (`isSupportedAtCheckout`, `:93-101`) with a
  `console.warn` the merchant cannot see.
- `previewFor` uses `marketId: "preview"` and `explainFor` uses `""`, so even
  if a rule were market-scoped, both would report `market_excluded`.

So the feature does not exist in any direction, three of the forty golden
vectors encode a shape production cannot produce, and the ADR's "dropped at
checkout, with a warning" describes a warning with no audience.

---

### P1-11 Multi-currency rule amounts cannot be entered, so absolute rules silently die outside the home currency

**Where:** `types.ts:62-69` (`CurrencyAmount.overrides`), `resolve.ts:73-78`,
`validate.ts:179`. Every production writer sets `overrides: {}`:
`rule-form.server.ts:188`, `csv/plan.ts:227`, `wizard.server.ts:135`,
`rule-from-sentence.server.ts:304`.

In a store selling in more than one currency, `amountInCurrency` returns null
for every `fixed_price` and `amount_off` rule outside the shop's own currency,
and the rule is skipped with `no_price_in_currency`. Percentage rules still
apply. So a buyer checking out in EUR loses exactly their negotiated contract
prices and keeps the percentage discounts, and the merchant has no field
anywhere to fix it. The golden vector
`an-absolute-discount-applies-when-the-currency-is-priced` tests a rule the
product cannot create.

Related: `ResolveOptions.rounding` is never passed by any caller either, so
Settings' "multi-currency rounding" (`pages-features.md:169`) does not exist and
`money.ts:170` justifies the option by pointing at it.

---

### P1-12 Two banners on the Pricing page are wired to constants and can never appear

**Where:** `app/routes/app.pricing._index.tsx:58-59` —
`unreadableCount: 0` and `cachedMinutesAgo: null`, hardcoded;
`app/components/pricing/RuleListPage.tsx:43,65` render on those values;
`app/lib/pricing/rules.server.ts:200-206` (`republish`) throws the real
`unreadable` list away into `console.error`.

`toEngineRules` exists precisely to report rows that cannot be decoded, and
`app/lib/customers/view-model.server.ts:218` does the equivalent wiring
correctly for tag rules. Here, a pricing rule that fails to decode is **absent
from checkout while displayed as Active**, and the banner written to say so
cannot render. This is the same class as the 6.1 truncation flag.

---

### P1-13 The buyer-facts backfill only publishes buyers carrying the one configured wholesale tag

**Where:** `app/lib/jobs/handlers/backfill-customers.server.ts:52-63`.

`isWholesale` is `groupId !== null || tags include record.wholesaleTag`. A rule
whose audience is `tags: ["gold"]` — which the builder actively encourages,
`emptyFormView` defaults `audienceMode` to `"tags"` — does not make a customer
"wholesale" by that test, so their `$app:mannon.buyer` metafield is never
written at install. Their admin price is right and their checkout price is
retail until someone edits them in Shopify. The criterion should be "tags any
active rule targets", or simply everyone.

---

### P1-14 A ruleset format bump silently charges every buyer retail

**Where:** `packages/pricing-engine/src/codec.ts:126-138`.

`deserializeRuleset` refuses a `v` it does not recognise and returns zero
rules. The comment argues this correctly — but the deployed Function's version
and the app's version move independently (`shopify app deploy` vs a server
release), there is no test pinning `RULESET_FORMAT_VERSION`, no migration path,
and the only signal is a `console.error` inside a WASM sandbox. The day someone
bumps the constant, every wholesale buyer on every store pays retail until a
human notices.

**Verified:** `qa/1.1-1.2/cold-read/abuse.test.ts` → a `v: 2` payload produces
zero discount candidates and one unreported error.

---

### P1-15 "The ruleset did not fit" is a one-shot query-param banner

**Where:** `app/lib/pricing/ruleset.server.ts:240-242`;
`app/routes/app.pricing._index.tsx:93`, `app.pricing.$id.tsx:142`;
`RuleListPage.tsx:55-63`.

Refusing to publish an over-48KB ruleset is the right call, and the last good
ruleset staying live is right too. But the merchant is told once, via
`?publishError=too_large`; one navigation later the Pricing page shows their
rules as **Active** with no indication that checkout is running something else.
The loader already reads `rulesetRuleCount` and `rulesetPublishedAt` and puts
them in the view — nothing compares them to the current active set, and
`rulesetHash` is never compared either. A persistent "checkout is N rules
behind" state is one comparison away.

---

### P1-16 The Function reads the wall clock, which Shopify Functions may not give it

**Where:** `extensions/mannon-discount/src/cart_lines_discounts_generate_run.ts:58`
— `const now = new Date();`, passed into every rule's schedule check.

Shopify's discount function input schema exposes `shop { localTime { date } }`,
which exists precisely because the Function sandbox's clock is not a
dependable source of the store's time. The input query
(`cart_lines_discounts_generate_run.graphql`) does not select it. If the
sandbox clock is fixed or epoch-zero, **every rule with a `startsAt` is
`not_started` at checkout and every rule with an `endsAt` never ends** — while
the admin shows them scheduled correctly.

I could not verify the runtime's behaviour from this environment. It is the
second thing to check on a dev store, and the fix (select `localTime`, fall
back to `new Date()`) is cheap enough to do regardless.

---

# P2 — quality, tests, and things that will bite later

- **P2-17 `asDate` swallows an unreadable date.**
  `rule-form.server.ts:44-49` returns `null` for anything `Date` cannot parse
  and adds **no issue**, so a rule the merchant meant to end runs for ever with
  no error beside the field. `qa/1.1-1.2/cold-read/schedule.test.ts`, third
  test.
- **P2-18 The "rounding happens once" vector cannot detect rounding per step.**
  `vectors.json` → `rounding-happens-once-at-the-end-not-per-rule` says _"two
  33.33% rules must agree with the maths"_ and then lists **one** rule. With one
  rule, per-step and once-at-the-end are identical by construction. The
  headline property of `resolve.ts:276` has no test.
- **P2-19 The golden vectors bypass the codec.** `golden.test.ts:59-134`
  builds `PricingRule` objects directly rather than through
  `deserializeRule`, so the wire format the Function actually reads is
  exercised only by `codec.test.ts`. Every vector would pass against a codec
  that dropped, say, `excludeCollectionIds` — which is exactly the field P0-1
  turns on.
- **P2-20 Checkout names only the first rule of a stack.**
  `cart_lines_discounts_generate_run.ts:177-181` picks
  `appliedRuleIds[0]`, so a buyer looking at a stacked price sees one rule's
  name. Invariant 5 again, on the buyer's side.
- **P2-21 The margin guard never checks cart-value rules.**
  `margin.ts:203` passes `cartSubtotal: null`, so `effectFor` returns
  `cart_unknown`, `priced` stays false and every candidate is counted
  `notApplicable`. A cart-value rule that sells below cost is reported as
  "not applicable", which reads as safe.
- **P2-22 `computeNextTier` keeps the current cart subtotal** while changing
  the quantity (`resolve.ts:311-314`), so the "add 8 more units" price quoted
  by the Buyer Agent is computed against a subtotal that cannot coexist with
  that quantity.
- **P2-23 `npm run lint` is currently red** on `qa/0.1/cold-read/probe.test.ts`
  — an untracked file from a parallel review. `qa/**` is not in
  `eslint.config.js`'s ignore list and `tsconfig.json` includes `**/*.ts`, so
  anything dropped in `qa/` is CI-visible. Worth deciding deliberately (ignore
  `qa/**/cold-read/**`, or keep probes lint-clean as this set is).

---

# Invariant check

| Invariant                                        | Result                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — every price comes from the engine**        | **Partly.** No price is computed outside the engine (I grepped for `/100`, `*0.`, `*quantity` across `app/**`; the only hits are quantities, chart geometry and percentage normalisation). But four surfaces feed the engine an **incomplete context** — no collections, no groups, no company, a unit-price "cart subtotal" — so one module still yields four answers. P0-2, P1-6. |
| **2 — every query scoped to one shop**           | **Pass, verified.** `qa/1.1-1.2/cold-read/tenancy.test.ts`: another shop's `PricingRule` reads as `null` by raw id, does not appear in `listRules`, and `getRule` outside any scope throws. The ruleset rides on each shop's own discount node, written only inside `shopScope.require`. No cross-tenant price path found. |
| **3 — AI drafts, a person approves**             | Pass for this area. `createRule` requires `approvedById` for an `aiAssisted` entry and commits the rule and the audit entry in one transaction (`rules.server.ts:223-251`).    |
| **4 — nothing claims to have happened that did not** | **Fail.** P0-1/P0-2 (prices claimed and not charged), P1-9 (preview claims an uplift checkout ignores), P1-10 (rules shown Active that cannot apply anywhere), P1-12 (a banner that cannot render), P1-15 (a publish failure the merchant stops being told about). |
| **5 — deciding shows its working**               | **Fail.** P1-6 ("Why this price?" answers wrongly for four of six audience modes), P1-8 (the trace shows a contract price applying and then being overwritten), P2-20.        |
| No unhandled promise rejections                  | None in the suite output.                                                                                                                                                     |
| No secrets in the client bundle                  | Pass. Nothing in `packages/pricing-engine` or the Function touches an env var; the only `process.env` read in this area is `SHOPIFY_DISCOUNT_FUNCTION_ID`, server-side in `ruleset.server.ts:96`. |
| No skipped or `.only` tests                      | Pass. The three `test.skip` calls are conditional capture guards in e2e specs.                                                                                                 |
| No new console noise                             | Pass in shipped code (`console.log`: zero hits in `app/`, `packages/`, `extensions/`). The Function's `console.error`/`warn` are its only channel — see P1-10, P1-14.          |

---

# Test plan and what it found

**Happy paths** — percentage, fixed price, amount off, volume tier, cart-value
tier, stacking, guest, untagged buyer, B2B company, per-line independence:
covered by the committed suite and green.

**Required states** — I forced each one rather than reading for it:

| State                     | How I forced it                                         | Result                          |
| ------------------------- | ------------------------------------------------------- | ------------------------------- |
| empty                     | no rules in the ruleset                                 | shelf price, no operations ✓    |
| missing data              | `collections: null` on the line                         | **P0-1**                        |
| missing data              | no `buyer` metafield                                    | guest treatment ✓               |
| error                     | ruleset that is not JSON / not an object / wrong `v`    | no throw; **P1-14** for `v`     |
| error                     | one malformed rule among good ones                      | that rule only ✓                |
| error                     | unparsable money on one line                            | **P0-3**                        |
| edge                      | quantity 0 / negative                                   | refused ✓                       |
| edge                      | discount to exactly zero                                | clamps, flags ✓                 |
| edge                      | rule that raises the price                              | **P1-9**                        |
| gated                     | non-`PRODUCT` discount class                            | no operations ✓ (and **P0-4**)  |
| gated                     | shop paused                                             | `activeEngineRules` returns none ✓ |
| offline                   | n/a for a Function — it cannot call out by design       | —                               |

**Three abuse cases I invented:**

1. **Malformed input** — a hand-edited `ruleset` metafield carrying
   `percentage: -50` (which would multiply by 1.5 and raise the price).
   `percentageEffect` refuses it as `invalid_rule`. **Passes.**
2. **Concurrent edits** — `updateRule` guards with a version check *and* an
   `updateMany where { id, version }`, re-reads on `count !== 1`, and throws
   `RuleConflictError` carrying the other person's row. **Passes** by
   inspection; `tests/integration/pricing-rules.test.ts` covers it.
3. **Wrong-tenant access by raw id** — `qa/1.1-1.2/cold-read/tenancy.test.ts`.
   **Passes**: not found, not a leak, and unscoped access throws.

**Screenshots:** none. This area has no rendered surface of its own — the
Pricing page's captures live in `qa/1.3/`. The findings that touch a screen
(P1-12, P1-15) are stated as code paths, not as pictures.

---

# What a re-run has to cover

After the fixes, re-run from step 2 of the gate, and add to the **committed**
suite:

1. A golden vector for a zero-decimal currency, built from a Shopify-shaped
   `MoneyV2` string.
2. A golden vector where the exact price lands on a half-cent tie (`$10.75`,
   6%), so the float regression cannot come back.
3. A golden vector with **two** rules for "rounding happens once".
4. A Function test whose ruleset goes through `JSON.parse(JSON.stringify(…))`
   before `deserializeRuleset`, so the wire format is exercised end to end.
5. A test that the storefront/quote/agent context and the Function context
   produce the same price for the same rule — including collections.
6. An assertion on the `discountAutomaticAppCreate` variables that
   `discountClasses` contains `PRODUCT`.
7. A test that `RULESET_FORMAT_VERSION` matches what `serializeRuleset` emits
   and what the deployed Function accepts.

And two things only a dev store can settle: **P0-4** (`discountClasses`) and
**P1-16** (the Function's clock). Neither should ship unverified — both are
"the feature does not work at all" shaped.

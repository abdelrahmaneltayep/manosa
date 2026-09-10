# Cold read — 5.1 ✦ Buyer Agent server

Independent adversarial review of commit `47db22b`, by a reviewer who did not
write it. Nothing here was taken from `qa/5.1/REPORT.md`; that report is treated
as a claim to falsify.

**Verdict: FAIL.**

§6 states one rule twice — "the agent can never invent a price", "prices only
from published rules (**test asserts this**)". The mechanism that implements it,
`unbackedFigures`, is **blind to an invented price in at least five shapes this
app itself emits**, and **refuses the two flagship examples §6 gives**. Both
halves are reproduced below with runnable evidence.

---

## 1. Test plan

Spec re-read: `feature-checklist.md` §6, `pages-features.md` §6, ADR 0023,
`CLAUDE.md` invariants 1–5.

**Happy paths** — price a SKU; build a cart; order status; net terms; next tier;
file a quote request; escalate; decline.

**Required states** — unpublished · not-an-approved-buyer · guest mode ·
taken-over · ability switched off · empty message · unknown SKU · model down /
no key / malformed output · reply states an uncomputed figure · over the turn
ceiling · plan lacks `buyer_agent` · conversation past retention.

**Three abuse cases I invented (not the author's):**

1. **Prompt-injected currency laundering.** The buyer's raw message is appended
   to the *reply* prompt (`replyUser`, last line). Make the model state an
   invented price in a shape the scanner cannot see: Arabic-Indic digits, a
   fullwidth yen sign, the word "dollars", a lowercase ISO code, or a swapped
   currency symbol on a number that *was* computed.
2. **Concurrent / replayed proxy requests.** Two first turns racing to create
   `AgentGuardrails`; a captured signed proxy URL replayed after the session
   ends; a guest posting in a loop.
3. **Wrong-tenant / wrong-buyer by raw id.** Another shop's rules, another
   buyer's orders and terms, another shop's conversation, `AgentGuardrails`
   (whose `@id` *is* `shop`).

---

## 2. Results

`npm test` — **1731 passed / 2 failed (93 files)**. Both failures are in
`tests/unit/storefront-blocks.test.ts` and are caused by **uncommitted 5.2 work
in the working tree** (`extensions/mannon-storefront/blocks/buyer-agent.liquid`
has no `"presets"` in its `{% schema %}`), not by 5.1. `tests/unit/buyer-agent-prompts.test.ts`
(19) and `tests/integration/buyer-agent.test.ts` (26) both pass.
`npm run typecheck`, `npm run lint`, `npm run build` — clean. Client bundle
grepped after a real build for the system prompts and for `ANTHROPIC`/`sk-ant` —
nothing. No `console.log` added; no `.only`, no skipped tests.

**Step 3 (walk the states) has nothing to render — 5.1 ships no screen.** That
is honest, and matches the author's report. It also means every state below is
argued from code and from module-level probes, not seen.

Boundary probes: the tenant extension does cover all three new models
(`AgentGuardrails` carries a scalar `shop`, so `scopedModelNames()` picks it up;
`findUnique`/`update`/`create` all get `shop` merged and `assertNoConflict`
agrees). Cross-shop reads of a conversation, of orders and of rules are already
asserted by the author's tests and I could not break them. **Invariant 2 holds.**

---

## 3. Findings, worst first

### P0-1 · The figure check is blind in every locale that does not use ASCII digits

`app/lib/ai/prompts/buyer-agent.server.ts` — `DIGITS` is built from `\d`, which
in JavaScript is ASCII `[0-9]` even under `/u`. `SYMBOL` omits `￥` (U+FFE5).

`formatCurrency` → `Intl.NumberFormat` emits Arabic-Indic digits for `ar-EG`
(and other Arabic and Persian regional tags) and the fullwidth yen for `ja`:

```
ar-EG EGP →  "‏١٬٢٠٠٫٥٠ ج.م.‏"      ja JPY → "￥1,200"
```

Probed against the real functions:

| allowed figures | model reply | `unbackedFigures` |
| --- | --- | --- |
| `["‏٩٠٫٠٠ ج.م.‏"]` | `سعرك هو ‏٩٫٠٠ ج.م.‏` (**a tenth of the real price**) | `[]` — accepted |
| `["￥1,200"]` | `お値段は￥12です` | `[]` — accepted |

`statedFigures` returns `[]` for *any* Arabic-Indic amount, so the guard can
never fire and **the model may state any price at all**. The mirror image is
equally broken: `bareNumber("‏٩٠٫٠٠ ج.م.‏") === "٫.."`, so if the model writes a
correct amount in ASCII digits it is refused as a fabrication.

§6 requires Arabic ("full Arabic UI + agent responds in the buyer's language
automatically"). This is the checklist's own headline market.

### P0-2 · An invented price in words, or with a lowercase code, is not money

All of these are accepted with `allowed = ["$90.00"]`:

```
"Your price is nine hundred dollars per unit."   → []
"Your price is 900 dollars per unit."            → []
"Your price is 900 usd per unit."                → []
"You get fifteen percent off."                   → []
```

The author's report discloses the bare-integer case ("a model that writes 410
meaning $410 would pass") but not that a bare integer **next to a currency
word** is an unambiguous, actionable price quote — which is what a merchant will
be asked to honour. The buyer's own message is passed verbatim into the reply
prompt, so a buyer can ask for exactly this shape ("just give me the number, no
symbols"). That converts a stated tolerance into a working exploit.

### P0-3 · `bareNumber` ignores the currency, so the agent may re-denominate a price

`bareNumber` strips everything but digits and dots, and `unbackedFigures`
accepts a stated figure whose `bareNumber` matches any permitted one. With
`allowed = ["$1,200.50"]`:

```
"Your total is €1,200.50."       → []   accepted
"Your total is EUR 1,200.50."    → []   accepted
"Your total is £1,200.50."       → []   accepted
```

The docstring justifies this ("a model that drops the currency code has not
invented anything") but the same leniency lets it **change the currency**. Mannon
is explicitly multi-currency (`Money.currencyCode` everywhere, KWD/BHD handled).
A buyer told €1,200.50 when the engine said $1,200.50 has been quoted a price.

### P0-4 · `bareNumber` deletes the decimal separator in comma-decimal locales — a 100× collision

`bareNumber` keeps only `[\d.٫]`. In `fr` (space grouping, comma decimal):

```
bareNumber("1 200,50 €")   === "120050"
bareNumber("120 050 €")    === "120050"
unbackedFigures("Votre total est 120 050 €", ["1 200,50 €"]) === []   accepted
```

The agent may quote **€120,050 for a €1,200.50 order** and the check calls it
backed. Same class for every space-grouped comma-decimal locale (fr, ru, pl, cs,
sv, nb, fi…). No test covers any locale but `en`.

### P0-5 · A fabricated percentage passes whenever it collides with an amount

`bareNumber("15%") === "15"` and `bareNumber("¥15") === "15"`.

```
unbackedFigures("You get 15% off, and 15% again next month.", ["¥15"]) === []
```

In a zero-decimal currency (JPY, KRW, VND, CLP) every figure is an integer, so
any percentage equal to any amount in the turn is waved through. §6 makes
discount authority a guardrail; a percentage is a price claim.

### P0-6 · The scanner's false positives break the two flagship flows §6 names

`\b[A-Z]{3}\s*DIGITS` matches ordinary wholesale English. Probed:

```
"Your terms are NET 30 and you owe $1,200.00."           → ["NET30"]   refused
"Your price for SKU 450 at 100 units is $9.50 each."     → ["SKU450"]  refused
"Price is $9.50; VAT 20 is added at checkout."           → ["VAT20"]   refused
```

Consequences:

- **`my_terms` is effectively unusable in English.** "NET 30" is the phrase the
  feature exists to say (`app/lib/orders/…`, §3 net terms). The reply is thrown
  away and the buyer is told something went wrong.
- **`pages-features.md` §6's own example** — "what's my price for SKU-450 at 100
  units?" — fails the moment the model writes the code with a space, which it
  will, because §6 writes it both ways.
- The same regex is used at `readRoutedTurn` → `MONEY.test(acknowledgement)`, so
  "Let me check SKU 450 for you." is rejected **before any tool runs**, burning
  the single repair round and risking `invalid_output` on the whole turn.

### P0-7 · A figure in the buyer's own message poisons the turn

`unbackedFigures("You mentioned $8.00; your price is $9.50.", ["$9.50"])` →
`["$8.00"]` → the turn is discarded.

`pages-features.md` §6's headline example is *"build me an opening order for a
20-table restaurant, **budget $3,000**"*. Any reply that acknowledges the budget
is thrown away. The feature's marquee use case cannot complete. There is no
notion of "figures the buyer supplied" anywhere in the design.

### P1-8 · `request_quote` double-applies the buyer's discount — `tools.server.ts:474`

```ts
listPrice: money(line.unitPriceAmount, context.currencyCode),
```

`line.unitPriceAmount` is the **already-discounted** unit price from `priceLine`.
`draftQuote` (`app/lib/quotes/quotes.server.ts:245`) re-prices every line with
`priceQuote` → `priceLine`, which treats the supplied `listPrice` as the
product's price and applies the buyer's rules to it again. A buyer on a 20% rule
gets a quote line at **0.8 × 0.8 = 64% of list**.

It is also invisible: `draftQuote` stores `listPrice: line.listPrice.amount`
(l. 265), so the admin's "list price" column shows the discounted figure and the
line reads as 0% off. `draftQuote` sets `lockedAt` and moves the quote to DRAFT,
so this is a price the merchant is one "Send" away from owing.

The integration test at `tests/integration/buyer-agent.test.ts:375` asserts only
`lines.length` and `status`, never a price — which is why this survived the gate.

### P1-9 · The same line is priced three different ways in one turn — `tools.server.ts:470`

`requestQuote` passes `productId: null`, so `priceLine` falls back to
`line.productId ?? line.variantId` and any **product-scoped rule stops matching**
on the quote draft, seconds after it matched in `priceLines` (which passes
`node.product?.id`, l. 185). `priceQuickOrder` passes `null` as well, so the
quick-order form and the agent already disagree on the same SKU for the same
buyer. Invariant 1 says one engine; it does not help if three callers feed it
three different inputs.

### P1-10 · `next_tier` invents an upsell — `tools.server.ts:397-400`

```ts
const breaks = rules.flatMap((rule) => rule.kind === "volume_tier" ? rule.value.tiers : []);
const next = nextVolumeTier(breaks, line.quantity);
```

Every volume tier in the shop is flattened, with **no check that the rule applies
to this product or this buyer's audience**, and **no check that the price at the
break is actually lower**. So the agent will tell a buyer "add 8 more units" for
a tier they can never reach, and `unit_price_at_break` may equal the price they
already have. §6 sells this as "add 8 more units and you unlock the 12% tier";
invariant 5 says a decision must show working a merchant can audit.

### P1-11 · The agent prices and carts draft/archived products

`priceLines` (l. 150-196) has no product-status check. Its sibling
`priceQuickOrder` (`quick-order.server.ts:191`) explicitly returns `unavailable`
for a non-`ACTIVE` product, with a comment explaining why. The agent quotes a
price for something the buyer cannot buy, and `build_cart` will hand it over.

### P1-12 · Cart lines lose the variant name — `tools.server.ts:186`

`title: node.product?.title ?? …` instead of `variantTitle(node)`. Three variants
of one product render as three identical "Mug" rows at three different prices in
the cart card §6 requires.

### P1-13 · Duplicate SKUs are not merged

Two lines of the same SKU (50 + 50) are priced independently at the 50-unit tier;
Shopify's cart will merge them into 100 and the Function will price the 100 tier.
The subtotal the agent states is not the one the buyer pays.

### P1-14 · `build_cart` ignores order limits and quantity increments

§6: "the agent assembles the cart at their prices, **respecting their limits**,
tiers, and visibility rules." Nothing in `tools.server.ts` consults
`app/lib/orders/limits.server.ts`. The agent hands over a cart checkout will
reject, which is the "conversation dangles" failure §6 forbids.

### P1-15 · Guest mode has no rate limit at all

`proxy.agent.tsx:47` gates on `context.customerId &&`, and `openConversation`
never reuses a conversation when `customerId` is null. So with `guestMode` on, a
visitor can post unlimited turns; each one costs **two Anthropic calls** and
creates a fresh `AgentConversation` + `AgentMessage` + a job enqueue. ADR 0023
claims "one buyer cannot spend the merchant's whole model budget, and neither can
a script pointed at the endpoint." For the only anonymous mode, that is false.

Same defect makes guest conversations memoryless (history is always empty) and
un-takeoverable, and fills the merchant's log with one-line threads.

### P1-16 · Rows are minted before the gates — `turn.server.ts:119` vs `126/131/135/137`

`openConversation` runs *before* the published gate, the approved-buyer gate, the
takeover gate and the empty-message check. An unpublished shop, a signed-out
visitor and an empty POST each create an `AgentConversation`. ADR 0023: "a shop
that has not published pays nothing to find out." It pays a row and a job enqueue
per request, unbounded, with no rate limit in front of it (P1-15).

### P1-17 · The proxy signature never expires — `app/lib/storefront/proxy.server.ts:88`

`proxyContext` verifies the HMAC but ignores `timestamp`. The signed query string
**contains `logged_in_customer_id`**, so any copy of one proxy URL (browser
history, a `Referer`, a pasted link, an access log) is a permanent bearer token
for that buyer. Before 5.1 that bought a price list; now it buys `order_status`
(order names, dates, totals) and `my_terms` (credit limit, outstanding balance).
Inherited from 3.4, but ADR 0023 puts the whole weight of the feature on this
signature — "the only thing standing between a stranger and another buyer's
order history" — so it needs a freshness window here.

### P2-18 · The conversation log will say "Answered" for turns nobody answered

`AgentConversation.outcome` defaults to `ANSWERED`, and `recordOutcome` is only
reached on success (`turn.server.ts`, after both model calls). Every failed turn
— `not_published`, `guest`, `taken_over`, `empty`, timeout, `unbacked_figure` —
and every empty row from P1-16 sits in the log as **Answered**. Invariant 4.

### P2-19 · `outcomeFor` reports a guardrail refusal as "Answered"

`conversation.server.ts` — `if (result.refusal) return result.tool === "decline"
? "DECLINED" : "ANSWERED"`. A buyer refused by `cart_off`, `quote_off`,
`orders_off`, `terms_off`, `sign_in` or `nothing_matched` reads as answered. The
docstring immediately above describes the opposite rule ("A refusal only wins
when nothing else did"); the code short-circuits on refusal before the switch.

### P2-20 · A buyer's words vanish during a merchant takeover

The `takenOverAt` gate (`turn.server.ts:135`) returns before `appendTurn`
(l. 139). While a merchant has the thread, everything the buyer types is
discarded — including from the merchant's own view. §6: "'Take over' hands live
chat to merchant (agent announces the human)."

### P2-21 · The decline is not scripted, and off-limits topics are prompt-only

§6: "Guardrail hits: **scripted decline**". `runTool` returns
`refusal: "off_limits"` and then `writeBuyerReply` still asks the model to write
the sentence. And nothing in code decides that a subject is off limits — the
model must choose `decline` on its own. ADR 0023's "a guardrail is a missing code
path, not a sentence in the prompt" is true of the four abilities and **not true**
of `offLimits`, which is the guardrail most likely to be tested by a hostile
buyer.

### P2-22 · `escalate` files nothing

§6 requires escalation that "files a message in the admin". `escalate` returns
`facts: ["escalated"]` and writes only a transcript row. Not listed as deferred
to 5.3 anywhere.

### P2-23 · No error boundary — a tool failure is a 500, not §6's error state

Neither `answerBuyerTurn` nor `proxy.agent.tsx` catches. `findVariantsBySku`
throws on GraphQL errors (`quick-order.server.ts:146`); `unauthenticated.admin()`
can throw; Prisma can throw. The buyer gets a bare 500 with no JSON, the widget's
"I'm having trouble — try again or use the quick order form" state is
unreachable, and no `AgentMessage` records the gap. Worst case: `requestQuote`
creates the `Quote` row (l. 452) and then throws inside `draftQuote`, leaving an
orphan `NEW` quote with no lines and a 500 on the wire.

### P2-24 · `loadGuardrails` races itself

Read-then-create with no upsert. Two concurrent first turns for a shop → `P2002`
on `AgentGuardrails.shop` → 500 for the loser. `db.agentGuardrails.upsert` exists
and the extension already handles `upsert`.

### P2-25 · Retention stops at uninstall, and the chain is fragile

`purgeConversations` returns `skipped: "uninstalled"` for an uninstalled shop,
and `purge-shop-pii.server.ts` does not touch the three new tables. A merchant who
uninstalls leaves their buyers' transcripts — company names, free text, order
totals, credit limits — in the database forever. Separately, the job only
re-queues from inside itself and from `openConversation`, so one lost run on a
shop with no new conversations ends retention silently.

### P2-26 · The plan gate lives in the Remix action

`proxy.agent.tsx:36` — exactly the mistake the author's own report lists as bug
#2 ("a rate limit inside a Remix action, where this environment cannot test it"),
repeated for billing. `answerBuyerTurn` is callable without an entitlement check,
which 5.3's test mode will do.

### Notes, not defects

- **`history.slice(0, -1)` at `turn.server.ts:154` is correct.** `historyFor`
  fetches `desc` and reverses, so the last element is the buyer message appended
  three lines earlier. (Side effect: `HISTORY_TURNS`/`HISTORY_LIMIT` are both 8,
  so the model actually sees 7 prior turns — two constants for one idea, in two
  files.)
- **`AgentGuardrails` behaves under the tenant extension.** `shop` is a scalar,
  so the model is scoped; `@id shop` means `update({ where: { shop } })` is legal.
  A cross-shop read raises `CrossTenantError` rather than reading as not-found,
  which is the extension's documented behaviour for an explicit `shop` and is
  consistent with every other model.
- Failed turns are stored with `text: ""` and fed back to the next turn as empty
  `agent:` lines in the history.
- `not_published` is returned with HTTP 200 to any holder of a signed URL,
  disclosing whether the merchant has published.

---

## 4. Invariants

| # | Rule | Verdict |
| --- | --- | --- |
| 1 | Every price from the engine | **Broken in effect.** The engine is the only thing computing, but the barrier between the model and the buyer (P0-1…P0-5) does not hold, and `request_quote` re-prices a priced line (P1-8) and drops product scope (P1-9). |
| 2 | Every query shop-scoped | **Holds.** All three models scoped; no path reads by raw id across tenants; `customerId` comes only from the signature. Caveat P1-17: the signature itself never expires. |
| 3 | AI drafts; a person approves | Holds for pricing. `request_quote` writes a `DRAFT`, `lockedAt` quote with no `aiAssisted` audit flag, so it does not appear as AI-assisted activity in the audit log even though a model chose it. |
| 4 | Nothing claims to have happened that did not | **Broken.** P2-18, P2-19, P2-20. |
| 5 | Deciding shows its working | Partly. `ruleSummary` is carried per line, but a reply that states it as a percentage is refused (P0-5's mirror), and `next_tier` shows working that may be false (P1-10). |

No unhandled promise rejections observed; no secrets or prompts in the client
bundle; no `console.log`, no skipped or `.only` tests. No value that belongs to
the engine is computed in a component (there are no components here).

---

## 5. Re-run required

Fix and re-run the whole gate from step 2. Two specific asks for the re-run:

1. **A locale matrix test for the scanner** — at minimum `ar-EG`, `ja`, `fr`,
   `de`, `KWD`, `JPY` — asserting both directions: a fabricated figure is caught,
   and the engine's own `formatCurrency` output is *not*.
2. **A price assertion on the quote path** — `tests/integration/buyer-agent.test.ts:375`
   must assert `quote.lines[0].unitPrice` and `.listPrice` against the engine for
   a buyer a rule actually reaches. As written it would pass with the discount
   applied four times.

---

## Fix pass — 2026-09-10, by the build agent

The verdict was right about the thing that mattered most: the check the whole
feature rests on could not be made to work by patching it. It has been replaced.

### The model no longer writes numbers

Scanning a reply for money and comparing it with a list of formatted figures was
the wrong shape. `\d` is ASCII-only, so Arabic was invisible; a currency could be
swapped and the number left alone; `1 200,50` and `120 050` collapse to the same
digits; "900 dollars" holds no symbol; and `\b[A-Z]{3}\s*\d` reads "NET 30" and
"SKU 450" as money, which made the two flows §6 leads with unusable.

So the tools now return **slots** — `{{f1}}`, `{{q1}}`, `{{s1}}`, `{{total}}` —
and the model writes prose around them. `checkReply` refuses a reply containing
any Unicode digit outside a slot, any currency or percent word (English and
Arabic), or a slot that was not supplied; `fillSlots` then substitutes the
values the engine computed, formatted in the buyer's own locale.

Every P0 above is closed by construction rather than by another pattern:

| Finding | Now |
|---|---|
| Arabic-Indic / fullwidth digits invisible | `\p{Nd}` — every script. Asserted in `ar`, `ar-EG`, `ja`, `fr`, `de`, `ar-KW`, `ar-BH`. |
| "900 dollars", "nine hundred dollars", "900 usd" | Currency words refused outright; the slot carries its own symbol. |
| Currency substitution, comma-decimal 100× collision | There is no comparison to collide: the value is ours, not the model's. |
| `15%` colliding with `¥15` | Same. |
| "NET 30", "SKU 450" refused | `{{days}}` and `{{s1}}` are slots. Both sentences asserted. |
| A figure from the buyer's own message | The acknowledgement may repeat digit-runs the buyer typed (`inventedNumbers`); the reply uses slots. |

The locale matrix the report asked for is `tests/unit/buyer-agent-prompts.test.ts`
→ "across the locales this app formats in", asserting both directions in eight
locale/currency pairs.

### P1

- **Double discount.** `draftQuote` is handed `line.listPrice` and the real
  `productId`, not the already-discounted figure and `null`. The test asserts
  the stored `listPrice` **and** `unitPrice`, which is what the old one missed.
- **`next_tier`** no longer flattens every tier in the shop. It prices candidate
  quantities through the engine, for this buyer, on this product, and offers a
  break only when the unit price actually falls. A distributor-only tier is no
  longer offered to a café.
- **Product status, variant titles, duplicate SKUs.** `priceLines` refuses a
  draft or archived product like `priceQuickOrder` does, uses `variantTitle`,
  and merges two lines naming the same SKU.
- **Guest mode has a ceiling and a thread.** `AgentConversation.guestKey`,
  derived server-side from the forwarded address and user agent hashed with the
  shop — a key the caller supplies is a ceiling the caller can step over.
- **Rows before gates.** Published, approved and non-empty are all checked
  before a conversation exists.
- **The proxy signature expires.** `MAX_SIGNATURE_AGE_MS`, 90 minutes, checked
  in `proxyContext` for every storefront endpoint. Both fixtures that signed
  without a timestamp were signing a request Shopify does not send.

### P2

`AgentOutcome` gains `FAILED` and ranks it lowest, so a conversation where
nothing worked no longer reads "Answered"; `outcomeFor` returns `DECLINED` for
any refusal and its docstring now matches; the buyer's message is stored before
the takeover check, so a merchant sees what they are meant to answer;
`offLimitsHit` enforces the merchant's subjects in code, on whole words, before
either model call, and the decline is scripted from the catalogue rather than
written by the model; `escalate` writes an `agent.escalated` audit entry, which
is what Home's activity feed reads; `loadGuardrails` upserts; and the uninstall
PII purge deletes conversations.

### Not fixed, and why

- **No error boundary around the Admin API.** A throw is still a 500 rather than
  a sentence. It is real and it is not this task's: every proxy route has the
  same shape, and one boundary in `withProxy` is the right fix. Recorded as the
  first item of 5.3.
- **An orphaned `NEW` quote** if `draftQuote` throws after `createQuote`. Same
  boundary, same task.

Re-run: **1,759 unit + integration across 93 files, 325 e2e — green.**

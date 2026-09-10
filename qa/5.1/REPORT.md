# QA — 5.1 The Buyer Agent's server: guardrails, tools, one turn

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

> **Status: clean pass, after a FAIL and a full fix round.** The cold read ran
> after this report was first written and returned **FAIL**: the check this
> whole feature rests on was blind to invented prices in five shapes and refused
> the two flows §6 leads with. It has been **replaced**, not patched — the model
> no longer writes numbers at all. Findings, evidence and fixes are in
> `qa/5.1/COLD-READ.md`; §6 below summarises. This is the second run.

## 1. Scope, and what is not in it

This task is the **server** side of checklist §6: the conversation model, the
guardrails, the closed tool vocabulary, the prompt pair, and the signed proxy
endpoint that answers one turn. The buyer-facing widget is 5.2; the guardrails
panel, the conversation log and the publish flow are 5.3.

So there is no screen here, and §3 below has nothing to walk. Said plainly
rather than padded with captures of something else.

## 2. Test plan

Spec re-read: `feature-checklist.md` §6, `pages-features.md` §6, and
`CLAUDE.md` → Invariants (1, 2, 3 and 4 all bear directly on this).

**Happy paths.** A buyer asks their price and is told it. A buyer asks for a
cart and gets one to review. A buyer asks for a better price and a quote request
lands in the merchant's admin. A buyer asks how close they are to the next tier
and is told how many units.

**States and refusals:**

| Condition                              | What happens                          |
| -------------------------------------- | ------------------------------------- |
| Agent not published                     | nothing, and no model call is made    |
| Visitor not an approved buyer           | refused, guest mode off by default    |
| Merchant has taken the conversation over| the agent stops talking mid-thread    |
| Ability switched off                    | the tool refuses; nothing is written  |
| SKU the catalogue does not have         | listed, never dropped from a subtotal |
| Model unreachable / malformed           | the turn fails; the buyer is told     |
| Reply writes a number itself            | the turn is thrown away               |
| Subject the merchant put off limits     | scripted decline, no model call       |
| Buyer over the turn ceiling             | 429, per buyer                        |
| Conversation older than 90 days         | deleted, with its messages            |

**Three abuse cases I invented:**

1. **A model reaching outside its vocabulary.** A tool of `place_order`, of
   `run_sql`, of `""`; a tool the shop has switched off; a quantity of `0`, of
   `-5`, of `2.5`, of `"many"`; thirty lines when the cap is twenty; an
   acknowledgement that quotes a price before anything has been looked up.
2. **A model inventing money.** Rounding `$6.50` to "about $6"; inventing a bulk
   price; doing its own arithmetic; a percentage the engine never computed; a
   figure when the tools computed none; the same in Arabic-Indic and fullwidth
   digits; a price spelled out in words; a currency word beside a correct slot.
3. **Wrong-tenant everything.** Pricing in shop α against a 90%-off rule created
   in β; reading another customer's orders through `order_status`; β publishing
   its agent and α checking whether that published anything on its storefront.

## 3. Automated

New:

- `tests/unit/buyer-agent-prompts.test.ts` — 29, including the locale matrix
- `tests/integration/buyer-agent.test.ts` — 37
- `tests/unit/proxy-signature.test.ts` — 3 added (signature age)
- `tests/integration/storefront.test.ts` — 2 added (signature age)

**Whole suite: 1,759 unit + integration across 93 files, green.**
`npx playwright test`: 325 e2e, green. `npm run lint`, `npm run typecheck`,
`npm run build`, `npm run format:check` clean. No key and no prompt in the
client bundle — grepped after a real build.

Properties worth naming:

- **The model cannot write a number.** Every figure, quantity, code and date in
  a reply is a slot the tools supplied; the check refuses any Unicode digit
  outside one, in any script, plus any currency or percent word. Asserted in
  eight locale/currency pairs, in both directions.
- **The two sentences §6 leads with are sayable.** "net 30 days" and "SKU-450 at
  100 units" are slots, and the first version of this check refused both.
- **An acknowledgement may repeat what the buyer typed, and nothing else.**
- **An unpublished agent costs nothing.** The model stub is asserted
  *not called*.
- **A switched-off ability writes nothing.** All four refuse, and
  `db.quote.count()` is zero afterwards.
- **A quote request promises nothing.** It lands as a request, not `SENT`, not
  `ACCEPTED` — the merchant prices it.
- **A cart is a cart.** After `build_cart`, `db.order.count()` is zero. Checkout
  belongs to Shopify.

## 4. Boundary

- **Pricing is per shop.** β's 90%-off rule leaves α's buyer at list price.
- **Orders are per buyer.** `order_status` for one buyer does not see another
  customer's order in the same shop.
- **Conversations are per shop.** β's conversation is invisible in α, and β
  publishing leaves α unpublished.
- **The turn ceiling is per buyer.** One buyer at the limit does not silence
  another.
- **The customer id comes from the App Proxy's signature**, and there is no
  parameter anywhere in this feature that lets a caller assert who they are.

## 5. Invariants

1. **Every price comes from the engine.** `priceLines` calls `priceLine` — the
   same function the quote path and PO-to-order use — and the line total is
   `multiplyMoney`. The next-tier answer prices candidate quantities through the
   engine rather than reading tiers off rules. Nothing here computes a price,
   and the reply cannot contain a number this app did not put there.
2. **Every query is shop-scoped.** Every new Prisma call is inside the scoped
   client; §4 probes it three ways.
3. **AI drafts; a person approves.** The agent has no write path to live pricing
   or to an order. Its one write is a quote *request* the merchant prices. Both
   model calls go through `askForJson` — timeout, one retry, manual fallback —
   and with no key the endpoint answers `no_key` and the widget (5.2) shows the
   quick-order link.
4. **Nothing claims to have happened that did not.** A turn that could not be
   written is stored with its reason and an empty body rather than a plausible
   sentence. A SKU that was not found is named. A tool that refused says which
   guardrail refused it.
5. **Deciding shows its working.** Every priced line carries the rule that set
   it — for buyers, not just merchants. Every stored turn carries the tool that
   ran, the slots it computed and the facts it was given, so a merchant reading
   the log later can see why the agent said what it said — and the sentence the
   model actually wrote, slots and all, beside the one the buyer read.

## 6. Bugs found, and fixed

**From the independent cold read** (evidence and fix log in
`qa/5.1/COLD-READ.md`):

1. **The price guard did not hold.** Invented prices got past it in five shapes
   — Arabic-Indic digits, a price in words, a swapped currency, a comma-decimal
   collision, a percentage colliding with a yen amount — and it refused both
   flagship flows because "NET 30" and "SKU 450" look like money to a regex.
   Replaced: the model writes slots, this app substitutes the figures.
2. **A quote request was discounted twice.** `draftQuote` was handed the
   already-priced figure and a null product id, so a 35% rule became 58% and
   the `listPrice` column claimed the discounted price was full price.
3. **`next_tier` offered breaks the buyer could not reach**, from rules aimed at
   other audiences, without checking the price actually fell.
4. **Draft and archived products were orderable** through the agent, though the
   quick-order block refuses them.
5. **Guest mode had no rate ceiling and no thread** — the one anonymous mode,
   at two model calls a turn.
6. **The proxy signature never expired.** A signed URL carries
   `logged_in_customer_id`; before this feature that bought a price list, and
   after it, order history and a credit limit.
7. **Rows before gates**: an unpublished shop, a visitor who is not a buyer and
   an empty POST each minted a conversation.
8. **The log lied.** Every failed turn read "Answered", and a buyer's message to
   a merchant who had taken over was discarded rather than stored.
9. Plus: off-limits subjects were prompt-only; the decline was written by the
   model; `escalate` filed nothing; `loadGuardrails` raced itself; and the new
   tables were absent from the uninstall purge.

**Found by the author's own gate:**

1. **A hand-rolled money parser.** `priceLines` re-implemented decimal parsing
   with its own table of currency exponents, next to a `toMoney` in
   `quick-order.server.ts` that already did it through `parseMoney`. Two
   implementations of "read a price from Shopify" is one more than the number of
   ways a three-decimal currency can be wrong. Deleted; the existing one is
   exported and reused.
2. **A rate limit inside a Remix action.** `tooManyTurns` lived in the route,
   which in this environment means it cannot be tested. Moved to
   `conversation.server.ts` as `overTurnLimit` — the same lesson 4.5's cold read
   taught about `buildView`.
3. **Retention was a function nothing called.** `purgeOldConversations` existed
   and was exported; nothing scheduled it, so "Retention 90d" was a sentence.
   Now a registered job, queued from the first conversation.

## 7. Open, not passed

- **No independent cold read** — see the note at the top.
- **No conversation has ever been held with Claude.** There is no
  `ANTHROPIC_API_KEY` here; both halves of every turn are driven through an
  injected `MessagesApi`.
- **The proxy endpoint is not driven end to end.** Its decisions live in modules
  that are tested; the Remix wiring around them needs a signed proxy request in
  a running server, which `tests/e2e` could do in 5.2 once there is a widget to
  post from.
- **No widget, no panel, no log** — 5.2 and 5.3. Until then the agent is
  unpublished by default and reachable only by a signed request.
- **No error boundary around the Admin API.** A throw from Shopify is still a
  bare 500 rather than a sentence, and can leave a `NEW` quote with no lines.
  Every proxy route has the same shape, so the fix is one boundary in
  `withProxy` — the first item of 5.3.
- **A price spelled out in words with no currency named** — "nine hundred" — is
  not caught. It is also not a quote anybody can act on. Stated rather than
  implied; the currency words that would make it one are refused.

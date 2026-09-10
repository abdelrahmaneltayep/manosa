# QA — 5.1 The Buyer Agent's server: guardrails, tools, one turn

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

> **Status: gate run, clean. No independent cold read yet.** The last two tasks
> both came back FAIL from that second pass, on findings this gate missed — so
> its absence here is a stated gap, and the first thing 5.2 should do.

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
| Reply states a figure nothing computed  | the turn is thrown away               |
| Buyer over the turn ceiling             | 429, per buyer                        |
| Conversation older than 90 days         | deleted, with its messages            |

**Three abuse cases I invented:**

1. **A model reaching outside its vocabulary.** A tool of `place_order`, of
   `run_sql`, of `""`; a tool the shop has switched off; a quantity of `0`, of
   `-5`, of `2.5`, of `"many"`; thirty lines when the cap is twenty; an
   acknowledgement that quotes a price before anything has been looked up.
2. **A model inventing money.** Rounding `$6.50` to "about $6"; inventing a bulk
   price nobody asked for; doing its own arithmetic (`$4.10 × 200`); describing
   a discount as a percentage the engine never computed; quoting a figure when
   the tool computed none at all.
3. **Wrong-tenant everything.** Pricing in shop α against a 90%-off rule created
   in β; reading another customer's orders through `order_status`; β publishing
   its agent and α checking whether that published anything on its storefront.

## 3. Automated

New:

- `tests/unit/buyer-agent-prompts.test.ts` — 19
- `tests/integration/buyer-agent.test.ts` — 26

**Whole suite: 1,726 unit + integration across 93 files, green.**
`npx playwright test`: 313 e2e, green. `npm run lint`, `npm run typecheck`,
`npm run build`, `npm run format:check` clean. No key and no prompt in the
client bundle — grepped after a real build.

Properties worth naming:

- **A reply may only repeat what the engine computed.** Five separate ways of
  getting it wrong are asserted, including the plausible one: arithmetic the
  agent did itself.
- **"100 units" is not a price.** The same check, asserted from the other side —
  a scanner that flagged quantities would be switched off in a week.
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
   `multiplyMoney`. The next-tier answer is `nextVolumeTier` over the same rules
   plus the engine's price at that break. Nothing in this feature computes a
   price, and the reply cannot state one that was not computed.
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
   ran, the figures it computed and the facts it was given, so a merchant
   reading the log later can see why the agent said what it said.

## 6. Bugs found, and fixed

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
- **The reply scanner is heuristic.** It reads money and percentages, not bare
  integers, on purpose. A model that writes "410" meaning $410 would pass; a
  model that writes "$410" would not. Stated rather than implied, and the
  reasoning is in `docs/adr/0023`.

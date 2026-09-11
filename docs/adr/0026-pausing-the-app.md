# 26. Pausing the app stops the rules, not just the storefront

Date: 2026-09-11 · Status: accepted

## Context

Checklist §8 asks for a danger zone with _"pause app (rules stop applying,
nothing is deleted — the safe 'turn it off' every merchant looks for)"_.

`Shop.pausedAt` had existed since 0.1 and was read in exactly **one** place:
`app/lib/storefront/proxy.server.ts`, which returns 503 while paused. So
pausing stopped the theme blocks and the Buyer Agent widget, and left the
discount Function pricing every checkout exactly as before — because Shopify
evaluates the published ruleset metafield without asking this app anything.

A merchant who pauses because a rule is wrong, and whose buyers keep getting
the wrong price at checkout, has been told something that did not happen.
That is Invariant 4, on the one control whose entire purpose is to be
trustworthy in a hurry.

## Decision

Pausing is enforced in two places, because there are two kinds of consumer.

**Everything in our own code reads `activeEngineRules()`**, which returns
nothing while paused. That function is the single read behind the ruleset
publish, quotes, PO-to-order, quick order and the Buyer Agent's tools, so
there is no path around it — and a rule saved during a pause cannot quietly
republish a live ruleset, because whatever republishes calls the same
function.

**Shopify's Function cannot call us**, so pausing also publishes an _empty_
ruleset to the metafield and resuming publishes the real one back. The write
happens after the flag is set, so if it throws part-way the two cannot
disagree in the dangerous direction: the flag is on, our code has already
stopped, and the Pricing page's `rulesetRuleCount` shows what is actually live
at checkout.

Nothing is deleted at any point. Rules, groups, buyers, quotes, orders and
settings all stay exactly where they were; resuming is one write plus one
publish.

## Alternatives rejected

**A `paused` flag inside the serialized ruleset.** The Function would read it
and return no discounts. Rejected: it needs a format-version bump _and_ a
Function redeploy, and until every shop's Function is redeployed an old one
would ignore the flag and keep discounting — a pause that silently does not
pause, which is the exact failure being fixed.

**Deleting the discount.** Reversible only by recreating it, which changes its
id and loses whatever a merchant had configured around it. "Nothing is
deleted" has to include Shopify-side objects.

**Gating each caller.** Five call sites is five chances to miss one, and the
sixth caller added later would not know. One choke point instead.

## Consequences

- Pausing costs one metafield write, and so does resuming. Both are idempotent
  through `rulesetHash`.
- `activeEngineRules()` now reads the `Shop` row on every call. It is a
  primary-key lookup on a row every one of those paths already loads.
- A paused shop's Pricing page shows `0` rules live at checkout, which is
  true, and the Settings banner says why.

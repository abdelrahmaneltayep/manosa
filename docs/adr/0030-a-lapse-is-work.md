# 30. A lapse is work, not a flag

Date: 2026-09-18 · Status: accepted

## Context

ADR 0005 settled the plan ladder and where gating happens: `assertFeature` and
`assertWithinLimit` in the service layer, never in a view, so a hand-crafted
request is refused too. That part held up — the 0.3 cold read verified seven
capabilities refusing correctly in the service layer.

What it did not settle is the case where **there is no request to refuse.**

Four of this app's capabilities are delivered by writing a metafield that
Shopify then evaluates on its own: the pricing ruleset the discount Function
reads, the order limits the validation Function reads, the net terms the
payment customization reads, and (since ADR 0029) the product's collection
membership. Nothing calls us at checkout. A gate in front of the _editor_
therefore changes nothing about what is already live.

So a merchant who cancelled kept every rule pricing, every minimum blocking
their buyers' carts, and every buyer's "pay in 30 days" on offer — for ever —
while the Plans page said "Paid features are paused" and `recordPayment` threw
`FeatureLockedError`. The app went on extending credit and stopped letting the
merchant record the money coming in against it.

The same shape had already been found twice: `pausedAt` stopped the storefront
blocks and left the Function pricing (6.4), and collection membership never
reached checkout at all (1.1/1.2).

## Decision

### Every publisher asks what the effective plan allows.

`activeEngineRules` truncates to the quota. `publishLimits` publishes an empty
set when the plan does not include limits. `publishBuyerTerms` publishes
`terms: null`. The check lives with the publish, not with the caller, so there
is no path around it — the same property that makes `activeEngineRules` the
right place for `pausedAt`.

### A plan change queues `billing.reconcile`, which runs them.

Queued by both plan writers — the Shopify sync and the
`app_subscriptions/update` webhook — and only when something actually moved.
It runs in **both directions**: a downgrade withdraws, resubscribing puts
everything back. Buyers are paged with a cursor on the shop row, like the
backfills, because a request-triggered runner has a timeout.

### Nothing is deleted, ever.

Appendix A: _features pause, data is never deleted_. Every rule, limit,
invoice and due date stays exactly where it is. Deleting or archiving what the
plan no longer covers would make resubscribing lossy, and the Plans page
promises the opposite in as many words: "they stay saved and stop applying
until you move back up".

### Which rules survive is the cascade's own order.

Priority ascending, then creation date — the same order the engine evaluates
in. This is not an implementation detail. Invariant 5 applies to a pause as
much as to a price: the merchant can predict which of their rules stays live,
and the answer is the same on every request rather than a coin toss. The
Pricing page names the count, because otherwise the list shows every rule as
**Active** while some of them apply to nobody.

## Consequences

- One new job kind, `billing.reconcile`, and two columns carrying its progress.
- An upgrade costs one sweep, which is the same work as a downgrade. Worth it:
  the alternative is a merchant who pays again and waits for an unspecified
  event to get their pricing back.
- A shop with no discount is not given one. A plan change is not a reason to
  create a live object in somebody's Shopify admin — the rule the pause path
  already follows.

## The general form, for the next capability

If a capability reaches a buyer through something Shopify evaluates without
calling us, then **the gate is half the feature and the republish is the other
half.** Shipping the gate alone produces a screen that says something true and
a checkout that does something else, which is Invariant 4 broken in the place a
merchant is least able to check.

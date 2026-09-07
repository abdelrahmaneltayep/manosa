# ADR 0005 — Billing and plan gating

**Status:** accepted (phase 0.3)

## The ladder

Free · **Pro $29** · **Growth $59** · Agentic $99, with two months free on an
annual subscription and a 14-day trial on every paid plan.

Pro is the entry paid tier and Growth the mid tier. That is deliberate and is
the ordering to build against; `PLAN_KEYS` and `rank` in
`app/lib/billing/plans.ts` are the source of truth, and nothing should infer an
ordering from the names.

## Manual pricing, not Shopify Managed Pricing

Managed Pricing would hand the whole plan page to Shopify. Checklist §9 needs
usage meters against quotas, a downgrade impact preview that names what pauses,
and later the Plan Advisor — none of which fit on a page we do not render. So
the Billing API it is, with our own Plans page.

## One catalog

`app/lib/billing/plans.ts` defines prices, entitlements and quotas once.
Shopify's billing configuration in `shopify.server.ts` is derived from it, so
the price a merchant is charged cannot drift from the price on the card.

Gating is by capability (`FeatureKey`), never by plan name. Moving a capability
between tiers is a one-line change instead of a search for `plan === "pro"`.

The billing plan ids (`pro-monthly`, `growth-annual`, …) become the
subscription `name` in Shopify and are how a live subscription maps back to a
plan. **Renaming one is a breaking change** — it silently drops paying
merchants to Free — so a test pins them and both the sync and the webhook refuse
to act on a name they do not recognise, loudly, rather than guessing.

## The cache, and why there is one

Shopify is the source of truth. The plan is cached on the `Shop` row because
the gate has to answer on every request, and an Admin API round trip per page
would cost latency against the LCP budget and burn rate limit on navigation.

Freshness comes from three places, in order of directness:

- the `app_subscriptions/update` webhook, which lands the moment anything
  changes — including a card expiring overnight, when nobody is watching;
- a forced sync on the Plans page, because that is where the merchant is about
  to act on what it says;
- a staleness check (one hour) on ordinary page loads.

A billing API outage does not take the admin down: the cached plan stays in
effect and the failure is logged.

## Lapsing pauses, it never deletes

`entitlementsFor()` separates `plan` (what they bought) from `effectivePlan`
(what applies now). A cancelled subscription drops `effectivePlan` to Free while
`plan` remembers what they had, so resubscribing restores everything.

A failed charge does **not** cut access. Shopify freezes the subscription; we
keep the paid plan working for a 7-day grace period so a merchant whose card
expired does not find their wholesale pricing offline the next morning. The
grace clock starts once and is never restarted by a later sync or a repeated
webhook — that would make it unlimited.

## Enforcement is server-side

`assertFeature()` and `assertWithinLimit()` in `gate.server.ts` are the
enforcement. Teasers and disabled buttons are courtesy; a request crafted by
hand still gets stopped.

`assertWithinLimit` takes the current count rather than counting for itself, so
the caller can count inside the same transaction as the insert. Counting
separately leaves a race where two concurrent creates both see `used = limit - 1`.

## No dark patterns

Built for Shopify forbids them, and the checklist calls it out. Concretely:

- A downgrade is the same control as an upgrade, one click, same wording shape.
- The downgrade preview names what pauses and counts what is over quota —
  "13 more pricing rules than Free allows", not "some rules may be affected".
- An upgrade takes effect immediately and prorates. A **downgrade waits for the
  end of the period already paid for**; taking that away would be the dark
  pattern.
- Cancelling prorates a credit rather than keeping the money.
- A test asserts that no urgency or guilt language appears on the page.

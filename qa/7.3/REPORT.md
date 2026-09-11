# QA — 7.3 Submission readiness

Date: 2026-09-11 · Gate: **pass** · **Submission itself is stop condition #1**

## 1. What this task is, and what it deliberately is not

The plan for 7.3 was to run Shopify's own App Store self-review requirements
against this codebase. **That could not be done here.** The canonical list is at
`shopify.dev`, which this environment's network policy blocks —
`shopify doc fetch` returns 403, and so does a direct request. The skill that
performs that review says, in as many words, *"Do not rely on a cached or
remembered list of requirements — always fetch the live page."*

So this task did not produce a compliance report. Writing one from a remembered
list would have been the exact failure this repo has spent seven milestones
catching: a document claiming something nobody checked. The requirements list
is named as unreachable, and that is the finding.

What was built instead is the part a machine **can** check from inside the
repository, each item objectively true or false about these files:
`npm run release:check`.

## 2. What it found

One blocker, and it has been true since 0.1:

```
✗ Every URL in shopify.app.toml is a real one
    5 URL(s) still point at a development host: https://localhost:3000,
    https://localhost:3000/proxy, https://localhost:3000/auth/callback, …
```

`application_url`, all three `redirect_urls` and the App Proxy `url` are
`https://localhost:3000`. Shopify *calls* these — OAuth, every webhook, the
storefront proxy — so a submission made on this file is rejected before a human
reads a word of the listing. `PROGRESS.md` has recorded it since 3.4 as a
deploy-time task; nothing has ever failed because of it, and a note in a
progress file is not a check.

Five things it confirms: the three privacy topics declared under
`compliance_topics` (the key that shipped wrong in 7.2 and would have made the
whole feature inert), `app/uninstalled` handled, `embedded = true` with App
Bridge loaded unbundled from Shopify's CDN, and charges going through the
Billing API.

Four things it refuses to guess at, each named: listing copy and screenshots,
the privacy policy and support contact, a real dev-store run, and a Lighthouse
number. All four are `?`, not `✓` — a check that quietly passed any of them
would be the report claiming something nobody did.

## 3. Automated

`tests/unit/submission-readiness.test.ts` — 6 tests. They assert the checker
still *notices*: that the localhost URLs read as blocked with an actionable
message, that the privacy topics read as ready, that the four unknowables stay
unverifiable, and that every check carries a reason somebody can act on.

`npm run release:check` exits non-zero when something is blocked, so it can sit
in a deploy pipeline. It is not part of `npm test`: the blocker it finds is
real and outstanding, and a red suite that everybody learns to ignore is worse
than no check at all.

## 4. Invariants

Only two apply. **Nothing claims to have happened that did not** is the whole
of this task, twice over: the report says what it is not, and every item it
cannot verify says so rather than passing. **Deciding shows its working** —
each check carries the sentence explaining what is wrong and what to do.

## 5. What still blocks an actual submission

1. **The app has never been deployed.** Every URL is localhost. Until it is
   deployed there is nothing to submit.
2. **It has never run on a real store.** Fresh install, reinstall, uninstall
   cleanup, a staff account with limited permissions, a 10k-product store —
   `CLAUDE.md` asks for all five and this environment can reach none of them.
   The discount Function has never run at a checkout, the theme block has never
   rendered in a theme, and no webhook has ever arrived from Shopify.
3. **No Lighthouse run.** The storefront budget is asserted by proxy.
4. **Listing, privacy policy, support contact** — written at submission.
5. **`ANTHROPIC_API_KEY` has never been set**, so no prompt in this app has
   ever been answered by Claude.

Items 2–5 are carried in `PROGRESS.md` under **Blocked**. Item 1 is now checked
rather than remembered.

**Submission is stop condition #1** in `CLAUDE.md` — the one thing the QA gate
is explicitly not enough for. This task makes the repo ready to be submitted by
a person; it does not submit it.

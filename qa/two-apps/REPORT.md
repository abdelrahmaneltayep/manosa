# QA — two codebases, one Shopify app

Date: 2026-09-19
Scope: the collision between this repository (`manosa`) and `manosh`, which
released a version to the Shopify app "Mannon" while this one was still
unlinked.

---

## What was about to happen

From the deploy you ran in `~/manosh`:

- `shopify app deploy` released **`mannon-6`** to the Shopify app **"Mannon"**
  (org `Mannon`, app `401839423489`), carrying the extensions
  **`quote-widget`** and **`customer-account-quotes`**.
- `fly deploy -a manosh` put that server at **`https://manosh.fly.dev`**.

And in this repository:

- `handle = "mannon"` — the same handle.
- **No `client_id` pinned.**
- `include_config_on_deploy = true`.
- A completely different extension set: `mannon-discount`, `mannon-limits`,
  `mannon-storefront`, `mannon-terms`.

`shopify app config link` binds a repo to an app **by handle** when no
`client_id` is pinned. So the next `npm run deploy` from here would have found
"Mannon", adopted it, written this file's config over that app's — URL,
redirect URLs, App Proxy, **access scopes** — and released a version containing
only this repo's four extensions, which removes `quote-widget` and
`customer-account-quotes` from the live app.

Nothing warns about that. The CLI prints the org and app it picked in an info
box and carries on. That is how two codebases end up fighting over one listing,
and it is what "I deployed two apps" would have become the first time this one
deployed.

**Nothing was clobbered.** This repo has never run `shopify app deploy`; the
collision was still in the future.

## What I changed, given your answer

You chose **two separate Shopify apps**, and **not deployed yet**.

### 1. This repo can no longer bind to the other app by accident

`handle` and `name` are now `mannon-wholesale`. A link from here cannot match
"Mannon".

### 2. Deploying is refused until one app is named

`app/lib/release/app-identity.ts` + `npm run check:app`, which `npm run deploy`
runs **first**:

```
$ npm run deploy
Refusing to deploy.

shopify.app.toml pins no client_id, so the CLI would bind this repo to
whichever app matches handle "mannon-wholesale" — and include_config_on_deploy
= true means this repo's config would then be written over that app's, and its
extension set over that app's.

Run `shopify app config link`, check the org and app it names, and commit the
client_id it writes. Deploying is refused until that line is in the file.
```

It also refuses when `SHOPIFY_APP_CLIENT_ID` disagrees with the pinned value —
the case an absent-minded `shopify app config link --reset` creates, where the
file is silently re-pinned and the deployer never reads it. A release cannot be
taken back from merchants who already have it.

### 3. The App Proxy subpath moved too

`subpath = "mannon-wholesale"`, and the four storefront blocks now call
`/apps/mannon-wholesale/...`. Shopify gives one prefix+subpath to one app, and
both apps will plausibly be installed on the dev store
`mannon-9iu9ewku.myshopify.com`. This was the cheapest possible moment to
change it — nothing is deployed, so no live storefront is calling the old path.

### 4. The URLs stay on localhost

Per your answer. `release:check` still reports that blocker, correctly.

## Test plan and results

`tests/unit/app-identity.test.ts` — **8 tests**, against the real
`shopify.app.toml`.

| Probe | Result |
| --- | --- |
| the handle is not `mannon` | pass |
| the config is still pushed on deploy — which is *why* the guard exists | pass |
| a deploy is refused while no `client_id` is pinned, naming the handle | pass |
| a deploy is allowed once one is pinned, with or without a matching env var | pass |
| a deploy is refused when the env names a different app than the file | pass |
| an empty or commented-out `client_id` reads as none | pass |
| the proxy subpath is distinct | pass |
| **every `apps/…/` in every Liquid block matches the TOML's subpath** | pass |

That last one is the drift guard. The blocks are Liquid and cannot import the
value, so the subpath has two writers and only shows up wrong on a real
storefront — which this repo cannot look at. **Reverted** (one Liquid path put
back to `apps/mannon/`): `expected [ 'buyer-agent.liquid: apps/mannon/' ] to
deeply equal []`. **Reverted** (handle back to `mannon`): 2 failed.

## Two pre-existing failures this surfaced, and fixed

Running the storefront e2e turned up two failures that were **already red
before my change** — confirmed by stashing the work and re-running.

`qa/3.4`'s captures were stale: they predate the `?hello=1` greeting handshake
that the Buyer Agent block fires when its panel opens for a signed-in customer.
Both tests were written before it too, and both were asserting against
whichever call happened to come first:

- *"answers, and says only what the app told it to"* did
  `calls.find(url.includes(agentPath))` and then asserted the method was POST.
  Once a GET handshake existed, the `find` returned that instead. It now finds
  the POST specifically.
- *"asks for nothing until a person joins"* asserted **zero** GETs. Its own
  comment says the concern is polling, not one request — so asserting zero was
  asserting the handshake did not exist. It now asserts exactly one, and that
  it is the handshake.

The captures regenerated as part of the run and carry both the handshake and
the new proxy path.

## Invariants

1–3, 5 — untouched. This is app configuration and a proxy path; no price, no
query, no AI path changed.
4. **Nothing claims to have happened that did not** — the whole of it. A deploy
   that silently adopts another team's app and releases over it is the app
   claiming an identity it was never given, and the two e2e tests were claiming
   a handshake did not exist.

## Suite

`npx vitest run` — **142 files, 2509 tests, all passing.**
`npx playwright test` — **426 passing.**
`npm run lint` clean, `npx tsc --noEmit` clean, `npx prettier --check .` clean.

## What this round does not prove

**I could not read `manosh`.** The clone was blocked by this session's sandbox,
so everything about it here is read from your screenshots: the app id, the org,
the two extension handles and the Fly host. I did not verify its `handle`, its
App Proxy subpath, or whether its `shopify.app.toml` also says `mannon`. If its
subpath is something other than `mannon`, the rename here is still correct but
was not strictly forced.

**Neither app has been installed alongside the other on one store.** The
prefix+subpath conflict is from Shopify's documented rule, not observed.

**`npm run check:app` has never been followed by a real `shopify app deploy`**,
because this environment cannot reach Shopify. What is tested is that it
refuses, and what it refuses on.

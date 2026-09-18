# QA — the localhost URLs in `shopify.app.toml`

Date: 2026-09-19
Scope: the standing blocker recorded in `PROGRESS.md` since 3.4 and reported by
`npm run release:check` as its only failing check.

---

## What was actually wrong

Five strings, all `https://localhost:3000`, in a checked-in file Shopify reads:

| Key | Value |
| --- | --- |
| `application_url` | `https://localhost:3000` |
| `auth.redirect_urls` | `…/auth/callback`, `…/auth/shopify/callback`, `…/api/auth/callback` |
| `app_proxy.url` | `…/proxy` |

The finding has always been stated as "the URLs are wrong". That is the
symptom. The defect is that **the app's origin was five strings a person had to
remember to change together**, in a file the Shopify CLI itself rewrites on
every `shopify app dev` (`automatically_update_urls_on_dev = true`). Anything
hand-typed into it is one dev run away from being replaced by a tunnel URL,
and a deploy made after that points a production app at a tunnel that has
already expired.

Meanwhile `SHOPIFY_APP_URL` already exists, is already **required** — the app
refuses to boot in production without it — and is already what the running app
uses for these exact callbacks. The file was the only place that disagreed.

## What I did not do

**I did not invent a hostname.** Nothing has been deployed, there is no
staging, and the repository does not record where this app will live. A
plausible-looking wrong origin in this file is strictly worse than
`localhost:3000`: the local one is obviously a placeholder and the check
catches it; `https://mannon.example.com` would look deployed, pass a glance,
and fail at OAuth on a real merchant's store.

So the origin is still the user's to supply. Everything around it is done.

## What I did

**One value, one command, five URLs.**

```bash
SHOPIFY_APP_URL=https://<host> npm run config:urls   # rewrites all five
npm run deploy                                        # does that, then deploys
```

`app/lib/release/app-urls.ts` is the whole mechanism, and three properties of
it are the point:

1. **Only the origin moves.** `/auth/callback` and `/proxy` are this app's own
   routes. A rewrite that rebuilt each URL from scratch could drop one and
   nothing would notice until OAuth failed on a real store, so the rewrite
   replaces the origin in place and keeps every path exactly as written.
2. **It writes nothing rather than something wrong.** `whyNotDeployable()`
   refuses http, a development host (`localhost`, `127.0.0.1`, `.ngrok`,
   `trycloudflare`, `.local`), a URL carrying a path, and anything that is not
   a URL — each with the reason, because both callers print it.
3. **The check and the fix share one scanner.** `submission.server.ts` used to
   carry its own regexes for these URLs. It now calls `appUrlSites()`, the same
   function the rewriter walks, so the thing that reports a wrong URL and the
   thing that fixes it cannot disagree about which URLs the file has.

The `release:check` report also stopped being a count. It was "3 URL(s) still
point at a development host", which leaves a person hunting the file for which
three — and `app_proxy.url` is the one nobody thinks to check. It now names
each key and says the command that fixes them.

## Test plan and results

`tests/unit/app-urls.test.ts` — **14 tests**, run against the **real
`shopify.app.toml`** rather than a fixture, because a fixture would keep
passing the day somebody adds a sixth URL to the config.

| Probe | Result |
| --- | --- |
| all five sites found, in file order, each named by its table | pass |
| every site's recorded offsets slice back to exactly its own text | pass |
| a development host is refused — 5 shapes | pass |
| http is refused | pass |
| an origin carrying a path is refused | pass |
| a non-URL, and the empty string, are refused | pass |
| a real origin is accepted, with and without a port | pass |
| every origin moves and every path survives | pass |
| the rest of the file is byte-identical afterwards | pass |
| the root URL gets no trailing slash | pass |
| running it twice changes nothing the second time | pass |
| a bad URL throws and writes nothing | pass |
| an already-deployed config moves to a new host | pass |

**Reverted** (the redirect-array scan removed, to simulate a missed site): 3
failed, including "finds all five in the file that ships" — which is the
failure that matters, because a scanner that misses a site would leave a live
localhost URL in a file the check had just called clean.

### Walked for real

The generator was run end to end against the real file:

```
$ SHOPIFY_APP_URL=https://mannon.example.com npm run config:urls
shopify.app.toml now points at https://mannon.example.com:
  application_url          https://localhost:3000 → https://mannon.example.com
  auth.redirect_urls       …/auth/callback        → …/auth/callback
  auth.redirect_urls       …/auth/shopify/callback → …/auth/shopify/callback
  auth.redirect_urls       …/api/auth/callback    → …/api/auth/callback
  app_proxy.url            …/proxy                → …/proxy

$ npm run release:check
  ✓ Every URL in shopify.app.toml is a real one
      All 5 point at https://mannon.example.com.
  …
Nothing here blocks a submission.
```

The file was then restored, because `mannon.example.com` is not where this app
lives and committing it would be the invented hostname this report refuses.

## Invariants

1–3, 5 — untouched; this is build configuration and touches no price, no
query and no AI path.
4. **Nothing claims to have happened that did not** — directly served. The
   refusals exist so that a deploy can never quietly configure the app against
   a host that is not serving it, and the check no longer says "set them to the
   deployed app URL" as if that were a thing a person does by hand.

## Suite

`npx vitest run` — **141 files, 2501 tests, all passing.**
`npm run lint` clean, `npx tsc --noEmit` clean, `npx prettier --check .` clean.

## What this round does not prove

**`npm run deploy` has never run.** This environment cannot reach Shopify, so
`shopify app deploy` is untested here; what is tested is everything that
happens before it hands over. The Shopify CLI's own behaviour — that it reads
these five keys, and that `include_config_on_deploy` pushes them — is taken
from the config file this repo already shipped, not verified against
`shopify.dev`, which is unreachable.

**The blocker is not closed.** `release:check` still reports one, correctly:
`SHOPIFY_APP_URL` has no production value because the app has no production
home. What changed is that supplying one is now a single variable rather than
five hand edits, and that getting it wrong is refused rather than deployed.

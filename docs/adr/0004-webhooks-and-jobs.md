# ADR 0004 — Webhook dispatch and the job runner

**Status:** accepted (phase 0.2)

## Webhooks

One registry (`app/lib/webhooks/registry.ts`) is the source of truth: topic,
URI, and handler together. `shopify.app.toml` declares the subscriptions, and a
unit test fails the build if the two disagree.

That test exists because both halves of the mismatch are silent in production:
a handler with no subscription simply never runs, and a subscription with no
handler 404s while Shopify retries it for 48 hours.

All subscriptions post to one splat route, `app/routes/webhooks.$.tsx`. Dispatch
keys off the topic header that `authenticate.webhook` has already verified, not
off the URL, so a mismatched path cannot route a payload into the wrong handler.

### Exactly-once

Shopify delivers at least once. A `WebhookDelivery` row keyed by
`(shop, webhookId)` makes a replay a no-op — otherwise an uninstall retry
queues a second PII purge, and the orders webhooks arriving in phase 3 would
double-count revenue. A delivery whose previous attempt _failed_ is re-run,
because that is what the retry is for.

Responses: 200 for handled, replayed and unrecognised topics alike — none of
them improve by being retried for two days. 500 only for a genuine handler
failure, which is the one case where a retry helps.

## Jobs

A `ScheduledJob` table and a runner, rather than a broker. The requirement is
"do this later, exactly once, and survive a restart", and Postgres already does
that.

- Claiming is a conditional update, so two runners racing on a row produce one
  claim and one no-op instead of two executions.
- Failures back off exponentially (1m → 60m) up to `maxAttempts`, then stop.
- A job whose handler no longer exists — removed by a deploy — fails loudly
  rather than retrying something nothing can run.
- `requeueStuckJobs()` returns work left `RUNNING` by a killed process.

The runner is driven over HTTP (`POST /internal/jobs/run`, bearer token,
constant-time compare) rather than a CLI script, because that works on every
host this app can run on without a second build pipeline for TypeScript that
Remix does not compile.

**Operational requirement:** `JOBS_RUNNER_TOKEN` must be set and the endpoint
scheduled. Without it the endpoint refuses to run — fail closed — and the
post-uninstall PII purge never happens, which is a GDPR obligation, not a
nice-to-have. The endpoint logs loudly in that state.

## Uninstall

Three things, in order of urgency:

1. Sessions are deleted immediately. An access token we can no longer use is a
   standing credential with no purpose.
2. The install is tombstoned (`Shop.uninstalledAt`).
3. The PII purge is scheduled at **+47h** — inside the 48h GDPR window, with an
   hour of slack for a late or backed-up runner.

A merchant who reinstalls in the meantime cancels the purge and keeps their
setup: `ensureShopRecord()` clears the tombstone and cancels pending purges on
the first authenticated page view.

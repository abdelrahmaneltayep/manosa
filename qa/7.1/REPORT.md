# QA — 7.1 A deployment that says what is wrong with it

Date: 2026-09-11 · Gate: **pass**

## 1. Test plan

7.1 is the release milestone's operational half: the things that decide whether
this app survives its first week in front of real merchants rather than its
first hour.

Reading the code for how it behaves when it is *misconfigured* rather than when
it is wrong turned up two gaps, and one of them is a security hole.

**The app booted happily without the secret it verifies with.**
`shopify.server.ts` read `process.env.SHOPIFY_API_SECRET ?? ""`. An empty
secret does not refuse a webhook — `createHmac("sha256", "")` is a perfectly
good deterministic HMAC — so a deployment that forgot the variable accepts a
delivery signed with an empty key, for any shop, on any topic. The App Proxy
already refused in that case (`proxy.server.ts` throws rather than defaulting);
nothing else did. Same shape, quieter, for `SHOPIFY_API_KEY!` and
`SHOPIFY_APP_URL ?? ""`.

**Nothing anywhere says the background runner has stopped.** Every job in this
app — the GDPR purge a merchant is promised within 48 hours, the retention
sweeps, quote expiry, the daily briefing — runs only because something outside
the app POSTs `/internal/jobs/run` on a schedule. If that cron is never set up,
or its token is wrong, or it silently stops, the jobs queue up `PENDING` for
ever and every screen looks fine. `README.md` has documented the cron since
0.2; nothing has ever checked it.

Abuse cases invented for this pass

1. A production boot with an empty `SHOPIFY_API_SECRET`.
2. A variable set to whitespace — set, or missing?
3. A probe endpoint read by an uptime checker: what does it hand out?
4. A job queued for an hour's time — is that a stalled runner?
5. A variable the code reads that nobody documented.

## 2. Automated

- `tests/integration/readiness.test.ts` — 9 tests: the environment check (names
  every variable with what breaks, refuses production, warns in development,
  reads blank as missing) and the readiness probe (ready, degraded, not fooled
  by a future job, leaks nothing, reports what is switched off).
- `tests/unit/environment-drift.test.ts` — 4 tests holding the list, the code
  and `.env.example` together.

Both were watched failing. The drift guard found a real one on its first run:
`SHOPIFY_DISCOUNT_FUNCTION_ID` is read by the pricing publisher and was in
neither the list nor `.env.example` — and without it wholesale prices are
computed correctly in the admin and never applied at checkout, which is the one
failure a merchant finds out about from a buyer.

## 3. The states, walked

No screens. `/healthz/ready` is the state, and its four are asserted directly:
ready (200), degraded on a stalled runner (503), degraded on a database that
does not answer, and ready-with-things-switched-off.

## 4. Boundary

The probe is deliberately unauthenticated — a load balancer cannot log in — so
the boundary question is what it discloses. A test seeds a shop with an email,
a failed job and an error string naming a database host, and asserts none of
the three appears in the response. Counts and booleans only.

## 5. Invariants

1. **Pricing engine** — untouched.
2. **Shop scope** — the probe reads outside a tenant scope on purpose (it is
   about the deployment, not a shop) and only counts rows.
3. **AI** — nothing here calls a model. `ANTHROPIC_API_KEY` is an *optional*
   variable and its absence is reported, not failed: the product works without
   it, which Invariant 3 requires.
4. **Nothing claims to have happened that did not** — this whole task is that
   invariant applied to the deployment rather than the screen. An app that
   cannot verify a signature now says so instead of verifying against nothing;
   a runner that has stopped is named rather than implied.
5. **Deciding shows its working** — every variable carries the sentence saying
   what breaks without it, and that sentence is what the boot error prints and
   what the probe returns.

Console: the boot check logs the optional list once per process and never under
test, so the suite gained no noise.

## 6. Not covered here

- **Nothing has ever been deployed.** There is no staging (`CLAUDE.md`), and
  production is stop condition #1. The boot check is exercised by calling
  `assertEnvironment("production")` directly, not by a production boot.
- The probe has not been read by a real load balancer.

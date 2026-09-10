# QA report — 4.1 · AI infrastructure: client, streaming, timeouts, audit hooks

Reviewed as someone who did not write it and does not trust it.

### 1. Test plan

The spec: `CLAUDE.md`'s fixed stack — "Anthropic API server-side only, every AI
call wrapped in timeout (20s), retry (1), fallback to manual path, audit-log
entry" — and invariant 3: "AI drafts; a person approves… every AI call has a
timeout, one retry and a manual fallback, and the product still works with the
key unset."

There is no key in this environment, so **no call has ever been made to
Anthropic**. Every test drives an injected stub. What is being proved is the
contract nine later features depend on, not the model's behaviour.

Happy paths: text back; JSON back, parsed and validated; an answer streamed a
word at a time.

Invented abuse cases:

1. **Malformed input and output.** JSON fenced, prefixed with a sentence, or
   absent. An answer that parses but fails the caller's own check. An empty
   answer. Several text blocks with a thinking block between them.
2. **A model that misbehaves.** One that never answers. One that throws a
   string, `null`, or a bare object. One that refuses. One that rejects the key.
   A stream that dies mid-sentence.
3. **Wrong tenant, and no tenant.** An AI call with no shop scope at all, and
   one shop's run log reaching another.

Plus one the invariants demand: **is the key in the client bundle?**

### 2. Automated tests

`npm test` — **1,214 tests, 65 files, all passing** (1,166 at 3.4). New:

- `tests/unit/ai-model.test.ts` (11) — the model resolves from the environment
  with the spec's default; the twenty-second timeout and the two-attempt cap are
  asserted as the promises they are; every feature has a prompt version; a blank
  key is no key.
- `tests/unit/ai-json.test.ts` (8) — JSON recovered from a fence, from behind a
  sentence, nested, and left alone when it is prose.
- `tests/unit/ai-bundle.test.ts` (4) — every module touching the SDK, the
  database or the key is named `.server`, and the built client bundle carries no
  key, no SDK and no Anthropic endpoint.
- `tests/integration/ai.test.ts` (27) — the whole contract: the no-key path, a
  success and what it records, the timeout and its single retry, a retry that
  succeeds, the three failures that are *not* retried, an empty answer, four
  kinds of thrown rubbish, JSON validation and its one repair, five streaming
  cases, and two tenant-boundary cases.

`npx playwright test` — **230 passing**, unchanged: 4.1 ships no screens.

Lint, `tsc --noEmit`, `npm run build` and `prettier --check` are clean.

### 3. State walkthrough

**No captures, and that is not a shortcut.** 4.1 is infrastructure: it ships no
route, no component and no merchant-visible surface. The states that matter are
the six failure reasons, and every one is exercised in `tests/integration/
ai.test.ts` against an injected stub — which is a stronger check than a
screenshot would be, because each asserts both the verdict the caller gets and
the row written to the run log.

The two existing ✦ teasers (the segment builder on Customers, the suggested
response on a quote) stay disabled. They are wired to `aiAvailable: false`, and
that is still true — not because there is no key, but because those features are
4.3 and 4.x. Lighting them up now would offer a button that does nothing.

### 4. Cross-tenant check

Two cases, both holding: an AI call outside a shop scope **throws before it
reaches the model** — a call with no tenant is one whose run row would land
nowhere; and one shop's runs never appear in another's log. `AiRun` carries
`shop`, so the DMMF-driven guard picks it up with no registration step.

### 5. The invariants

| Rule                                           | Status at 4.1                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every price comes from the pricing engine      | Held, structurally: nothing in `app/lib/ai/*` can write a row or compute a price. It returns text.                                                                                 |
| Every query is shop-scoped                     | Held, and the wrapper refuses to run at all outside a scope.                                                                                                                       |
| AI drafts, a person approves                   | Held by construction. The model's output and the write path are in different modules, and `recordAudit` refuses an `aiAssisted` entry with no approver — enforced since 0.2.        |
| Nothing claims to have happened that did not   | A refusal is a refusal, not an empty answer. An empty answer is `invalid_output`, not a blank draft. A JSON value that fails the caller's check is never returned. No key is recorded as `NO_KEY`, so a quiet feature has a reason. |
| Deciding shows its working                     | Every run carries the model and the prompt version, so an answer stays explicable after the wording changes.                                                                        |
| No secrets in the client bundle                | Checked two ways — the naming convention, and the built bundle. Both clean.                                                                                                        |
| No PII in logs                                 | The run log holds no prompt and no completion, and a test feeds a company name, an email and an amount through a call and asserts none of them reach the row.                       |

### 6. Bugs found and fixed

1. **The "a failed log never denies an answer" guarantee was in the wrong
   place.** It lived inside the default recorder's own try/catch, so it was a
   property of that one implementation rather than of the wrapper. Any other
   recorder — including the one a test injects — would take the answer down with
   it. Found because the test that injects a failing recorder failed with `disk
   full` instead of returning the answer. Moved to `recordSafely` at the call
   site, so it holds for every recorder.

2. **Spying on a Prisma delegate breaks it permanently.** The first version of
   that test used `vi.spyOn(db.aiRun, "create")`. A Prisma delegate resolves its
   methods through a proxy, so `mockRestore()` leaves `create` as `undefined` —
   and three later tests in the same file failed with "no record found". Not a
   product bug, but a trap worth naming: it is now in `PROGRESS.md`, and the
   test injects a recorder instead.

3. **`resetAnthropicClient` had no way to be reached from a test** that needed
   the client rebuilt after the key changed, and the SDK exposes `messages` as
   an instance property rather than a prototype getter — so the obvious mock
   does not work. Resolved by making the messages API injectable, which is the
   idiom this repo already uses twice (`AdminForShop`).

Two things were removed rather than fixed: a `Anthropic` type re-export from the
streaming module that earned nothing, and a duplicated run-recorder that existed
in two files before the shared one.

### 7. Open items

- **No call has ever been made to Anthropic.** There is no key here. Every test
  drives a stub, so what is proved is the wrapper's contract — the timeout, the
  retry rule, the failure verdicts, the run log — and **not** that any of
  Mannon's prompts produce a useful answer. That is the first thing to check
  when a key exists.
- **The model is `claude-sonnet-4-5`, which the spec names and which is a
  previous generation.** The current equivalent is `claude-sonnet-5`;
  `claude-opus-5` is more capable. It is one environment variable. See
  `DECISIONS.md` — flagged rather than silently upgraded.
- **Thinking and effort are not configured.** They are model-dependent, and the
  wrapper sends neither so it works on either generation. A feature that knows
  its model can opt in.
- **No rate limit and no budget cap.** A plan limit on AI calls belongs with the
  features that spend them; the run log is the data it will count. Nothing today
  stops a merchant on Free from being served by a store-wide key — except that
  every AI feature is also plan-gated at its own entry point.
- **Prompt caching is declared but unverified.** The stable half of every prompt
  carries `cache_control`, and a test asserts it is sent — but no cache has ever
  been read, so `cache_read_input_tokens` has never been non-zero outside a
  fixture.
- **The run log is never pruned**, and it will be the highest-volume table in
  the app once the agents ship. Retention lands in 7.2.

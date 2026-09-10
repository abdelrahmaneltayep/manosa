# 18. One way to ask Claude, and a product that works without it

Status: accepted (phase 4.1)

## Context

Nine features in the remaining phases call a model: a rule from a sentence, a
margin check, registration screening, drafted emails, segments, the CSV
whisperer, the merchant briefing, PO parsing, and two agents.

Nine features means nine chances to forget the timeout, nine chances to leave a
merchant staring at a spinner, and nine chances to let a model's answer reach
live pricing without anybody agreeing to it.

## Decision

### One wrapper, and nothing goes round it

`app/lib/ai/run.server.ts` is the only way this app talks to Claude. Everything
the invariants ask for is in it, so no feature can omit it:

- **A timeout of twenty seconds**, raced by our own timer as well as the SDK's —
  the SDK's clock does not cover time spent inside a stream.
- **One retry, and only where a retry helps.** A refusal, a bad request or a
  rejected key will fail identically the second time; retrying them just makes
  the merchant wait twice as long for the same fallback. A rejected key is
  especially not retried — that is how an account gets locked.
- **A recorded run**, every time, including the ones that failed and the ones
  that never happened because there is no key.
- **A verdict, never a throw.** Every path returns `{ ok: false, reason }` with
  a reason a caller can act on. A merchant mid-way through pricing their
  catalogue does not get a stack trace because a model had a bad minute.

### The product works with the key unset

`isAiAvailable()` is a first-class state, not an error. With no key, calls
return `no_key` and record a `NO_KEY` run — so a feature that has gone quiet has
a visible reason rather than being a mystery.

This is why every AI feature in the phases ahead needs a manual path _first_.
The AI is the fast way to do something a merchant can already do by hand.

### The model never writes

Nothing in `app/lib/ai/*` can change a row. It returns text. Turning that into a
change is the feature's job, and `recordAudit` (0.2) refuses an `aiAssisted`
entry that carries no approver — so the invariant is enforced by the audit
layer, not by nine features remembering.

### Nothing believes the answer

`askForJson` takes a validator from the caller and **does not return a value
that fails it**. One repair attempt, with the error handed back so the model is
told what a correct answer looks like, and then the manual path. A half-valid
pricing rule reaching a merchant's catalogue is exactly what invariant 1 exists
to prevent.

### The run log holds no prompt and no completion

`AiRun` records the feature, the model, the prompt version, token counts,
latency and the provider's error. Not the prompt, not the answer. Those carry
the merchant's product data and their buyers' names, and "what has this been
doing" and "what is it costing me" are both answerable without them.

The prompt _version_ is recorded on every run, so an answer given six months ago
is still explicable after the wording has changed twice.

### Streaming, in two places only

Non-streaming is right for almost everything: a rule the merchant will approve
does not need to appear a word at a time, and one response is simpler to
validate. `streamText` exists for the rule builder and the agents, where a
pause of eight seconds reads as broken.

It follows the same rules, plus one: a stream that dies mid-sentence yields a
failure chunk rather than throwing, so whatever arrived is still on screen and
the UI decides what to do with it.

### Two seams, and the app never uses them

`askForText`, `askForJson` and `streamText` take an optional `AiDeps` with a
messages API and a run recorder — the same idiom a webhook handler uses for
`AdminForShop`. It is how the timeout, the retry rule and every failure path get
driven in a test with no key, without reaching Anthropic.

## Consequences

- **The configured model is `claude-sonnet-4-5`, which the spec names and which
  is a previous generation.** It is one environment variable
  (`MANNON_AI_MODEL`), and `DECISIONS.md` records why it was not silently
  upgraded. The current-generation equivalent is `claude-sonnet-5`.
- **No call has ever been made.** There is no `ANTHROPIC_API_KEY` in this
  environment, so every test drives an injected stub. What the model actually
  returns for any of Mannon's prompts is unknown until a key exists.
- **Thinking and effort are not configured.** They are model-dependent —
  `budget_tokens` on Sonnet 4.5, adaptive on the current generation, and
  `effort` errors on the older one — so the wrapper sends neither and each
  feature can opt in when it knows which model it is on.
- **`askForJson` costs at most two calls.** The ask and one repair. A model that
  cannot produce valid JSON twice is a merchant paying for a loop.
- **No rate limiting or budget cap yet.** A plan limit on AI calls belongs with
  the features that spend them; the run log is the data it will count.

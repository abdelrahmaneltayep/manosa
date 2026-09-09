# 11. Auto-tagging decides in a pure module, and never on its own

Status: accepted (phase 2.1)

## Context

A tag is not a label in this app. Pricing rules target tags, so adding `gold`
to a customer changes what they pay at checkout. An auto-tagging engine is
therefore a pricing engine with a longer fuse: it decides prices for people who
are not in the room.

## Decision

**The deciding is a pure function.** `app/lib/customers/tagging.ts` takes rules,
facts and a `now`, and returns which tags to add and remove. No clock, no
database, no network — asserted by a test that reads the file and fails on
`Date.now()`, `new Date()`, `Math.random` or `process.`. The only import is the
pricing engine's money helpers.

This is what makes the preview trustworthy. The merchant is shown "84 buyers
would change", with examples; when they press apply, the same function decides
again, from the same facts. A preview computed one way and an apply computed
another is a promise the software cannot keep.

**Nothing runs on its own.** There is no nightly sweep. The merchant presses
"Apply to customers" and sees what happened. A background process that
re-prices a customer base without anyone watching is not a feature this app is
willing to have before its audit and reporting story is finished.

## The rules that fall out of "a tag is a price"

- **A rule with no conditions matches nobody.** The other reading — a rule with
  no conditions matches everybody — would tag an entire customer base on a
  half-finished rule.
- **A condition that cannot be read disables its rule.** Dropping the condition
  and running the rest would make the rule match _more_ people than it was
  written to match.
- **Money is never converted.** A rule written in USD does not apply to a EUR
  buyer. Deciding that €1,000 clears a $500 threshold means inventing an
  exchange rate, and the tag it applies changes a price.
- **A buyer who has never ordered has no "days since last order".** Treating
  that as infinity sweeps every new signup into a win-back segment.
- **The last rule to speak about a tag decides it.** When one rule adds `vip`
  and another removes it, someone has to win, and "the later rule" is the only
  answer that can be explained on a page.
- **One buyer Shopify refuses does not stop the sweep.** They are counted as
  failed and reported; the other four hundred still get their tags.

## Consequences

- Form answers are a condition kind the engine understands and no data feeds
  yet (forms land in 2.2). A rule that reads an answer matches nobody until
  there is an answer to read, rather than matching everybody.
- Auto-tagging is gated on the plan server-side, in `createTagRule`,
  `updateTagRule` and `runTagSweep` — not only in the UI.
- The engine is not in `packages/`. It has one consumer and depends on the app's
  own view of a buyer; the pricing engine is shared with a WASM Function and
  earns its package. If a second consumer appears, it moves.

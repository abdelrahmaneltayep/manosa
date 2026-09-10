# QA — 5.3 Guardrails panel, test mode, conversation log, publish flow

Hat: senior QA engineer who did not write this code and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

## 1. Scope

Checklist §6's three remaining blocks: the **guardrails panel** (abilities,
tone, instructions with the lint, off-limits, test mode), the **conversation
log** (list, transcript, take over, CSV, retention), and the **publish flow**
(the four-item pre-publish checklist, publish with a storefront link, unpublish
in one click).

Plus the two items 5.1's cold read left open and named as 5.3's first job:

- **An error boundary around the Admin API.** `withProxy` now lets a `Response`
  through untouched and turns anything else into a logged 502, so a buyer
  standing on the merchant's storefront gets a sentence rather than a stack
  trace.
- **The orphaned quote.** `priceLines` and `draftQuote` inside `requestQuote`
  now fail softly. A `NEW` quote carrying the buyer's own words is exactly what
  the merchant needs to answer; an exception used to delete it and tell the
  buyer nothing.

## 2. Test plan

Spec re-read: `feature-checklist.md` §6, `pages-features.md` §6, `docs/adr/0023`
and `CLAUDE.md` → Invariants (2, 3, 4 and 5 all bear on this).

**Happy paths.** A merchant switches an ability off and it takes effect. A
merchant rehearses as one of their buyers and sees the cart the agent would
build. A merchant completes the checklist and publishes. A merchant reads a
conversation back and joins it.

**States:**

| Condition                                     | What happens                              |
| --------------------------------------------- | ----------------------------------------- |
| Fresh shop                                    | four outstanding items, publish is off    |
| Draft rule / pending buyer / failed rehearsal | still four outstanding — none of them tick|
| All four done                                 | publish turns on                          |
| Publish POSTed while outstanding              | refused, named, nothing changed           |
| Published                                     | confirmation + storefront link            |
| No primary domain known                       | says so instead of inventing a link       |
| Unpublish                                     | instant, one click, guardrails kept       |
| Instructions over 200 words                   | error beside the field, not saved         |
| Instructions contradict an ability            | warning, still saved                      |
| Plan without `buyer_agent`                    | banner, controls disabled, data intact    |
| No conversations ever                         | "publish the agent to start"              |
| Published but quiet                           | a different empty state                   |
| Filter matches nothing                        | "no conversations match" + clear          |
| A turn nobody could answer                    | shown as that, with its reason            |
| Conversation taken over                       | agent silent from the next message        |
| Rehearsal                                     | labelled everywhere; take-over refused    |
| No `ANTHROPIC_API_KEY`                        | test mode says so; the page still works   |
| No approved buyers                            | test mode asks for one first              |

**Three abuse cases I invented:**

1. **Publishing without the checklist.** POST `intent=publish` with each item
   missing in turn; a draft rule, a `PENDING` buyer and a rehearsal whose only
   outcome is `FAILED` all present, so every row exists and none of them counts.
2. **A rehearsal that writes.** Route the model to `request_quote` and to
   `escalate` in test mode and then count `Quote` rows and `agent.escalated`
   audit entries.
3. **Wrong-tenant everything.** Read β's conversation by id in α; take it over;
   export in α and grep for β's buyer; rehearse in α as β's customer id.

## 3. Automated

New:

- `tests/unit/agent-panel.test.ts` — 13
- `tests/unit/agent-pages-states.test.tsx` — 24 (also the captures)
- `tests/integration/agent-panel.test.ts` — 27

**Whole suite: 1,823 unit + integration across 96 files, green.**
`npx playwright test`: 350 e2e, green. `npm run lint`, `npm run typecheck`,
`npm run build`, `npm run format:check` clean. No key and no prompt in the
client bundle — grepped after a real build.

Properties worth naming:

- **The publish gate is enforced server-side.** `publishAgent` throws
  `NotReadyError` and writes nothing; `published` stays false and no audit
  entry appears.
- **A row is not a tick.** A `DRAFT` rule, a `PENDING` buyer and a `FAILED`
  rehearsal leave all four items outstanding.
- **A rehearsal writes nothing.** After a test turn routed to `request_quote`,
  `db.quote.count()` is 0; after one routed to `escalate`, there is no
  `agent.escalated` audit entry. The stored turn carries `refusal: "test_mode"`,
  so the merchant is told rather than shown a quote number that does not exist.
- **A rehearsal and a real conversation never join**, even with the same buyer
  in the same minute.
- **A closed rehearsal is kept.** `closedAt` is set, the next message opens a
  new thread, and the old one is still readable.
- **Taking over is idempotent** — two presses announce once, and the first
  person keeps the credit.
- **Replying takes over**, whether or not the button was used.
- **The buyer's words survive a takeover.** A message sent to a conversation a
  person has joined is stored; only the agent stops.
- **The CSV defuses formulas.** A buyer message starting `=HYPERLINK(...)` is
  written as `"'=HYPERLINK…`, and every rehearsal row carries `test,yes`.

## 4. Boundary

- **Another shop's conversation reads as not found.** `readConversation`
  returns null and `takeOver` throws — not a 403. The difference between "no
  such thing" and "yes, but not for you" is the leak.
- **The log is per shop.** β's 1 conversation leaves α's total at 0, and α's
  export contains α's buyer and not β's.
- **Publishing is per shop.** β publishing leaves α unpublished.
- **A rehearsal cannot be run as another shop's buyer.** A customer id in the
  form is not proof of anything: `rehearsalView` decides who may be rehearsed
  as, from this shop's approved buyers, and falls back to the first of them.
  Asserted directly.

## 5. Invariants

1. **Every price comes from the engine.** 5.3 adds no pricing. The rehearsal's
   cart card renders `PricedToolLine` exactly as the storefront widget does,
   including the rule that set each line.
2. **Every query is shop-scoped.** Every new Prisma call is inside the scoped
   client; §4 probes it four ways.
3. **AI drafts; a person approves.** Test mode is the strongest form of this in
   the app: the merchant watches what the agent would do, and the two tools that
   write are off. Publishing is a person's decision behind a four-item gate.
4. **Nothing claims to have happened that did not.** A turn with no text says
   "the agent couldn't answer this one, nothing was sent to the buyer" and
   carries its reason. A rehearsal is labelled on the row, on the transcript and
   in the CSV. With no key, test mode says Claude is not connected instead of
   failing quietly. A shop with no known domain gets a sentence, not a guessed
   link.
5. **Deciding shows its working.** Every transcript turn shows the tool that
   ran and the facts it was given; the rehearsal's cart shows the rule behind
   each price; the lint quotes the merchant's own phrase back.

## 6. Bugs found by this gate, and fixed

1. **`s-button` carries no `name` or `value`.** The "start a fresh test" button
   shared a form with Send and set its intent through button attributes that a
   Polaris button does not have — it typechecked as JSX but would have submitted
   `intent=say` with an empty message. Its own form, with a hidden field.
2. **An empty table header key was identical in both catalogues**, which the
   i18n guard reads as an untranslated string. It was also an unlabelled column
   for a screen reader. Now "Transcript" / "النص".
3. **Take-over on a rehearsal.** The screen hid the buttons, so nothing would
   have gone wrong through the UI — which is exactly the shape of bug this
   project keeps finding. `takeOver` and `replyAsMerchant` now refuse a
   `testMode` conversation themselves.

## 7. Open, not passed

- **No independent cold read yet** — `autopilot:qa-engineer` runs next. The last
  three tasks all passed this gate and all three came back FAIL.
- **No merchant has seen any of these screens.** Polaris never upgrades here, so
  the 24 captures in this directory are structure only. They prove which content
  and which states render, and that no raw i18n key reached a page. They do not
  prove what a merchant sees.
- **No conversation has ever been held with Claude.** There is no
  `ANTHROPIC_API_KEY` here, so every rehearsal in these tests is driven through
  an injected `MessagesApi`. The `noKey` state is therefore the only one that
  has been exercised for real.
- **The publish switch has never met a theme.** `published` is our own flag and
  the widget honours it, but the theme app embed itself is enabled by the
  merchant in the theme editor, which this environment cannot reach. The
  checklist's "publish = theme block enable" is therefore half done: our half.
  Stated on the screen — the storefront link is where the merchant checks.
- **The CSV has never been opened in a spreadsheet.** The injection guard is
  asserted on the bytes, not on Excel's behaviour.

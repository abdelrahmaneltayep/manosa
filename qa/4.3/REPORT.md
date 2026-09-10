# QA — 4.3 Registration screening, drafted emails, segments, CSV whisperer

Hat: senior QA engineer who did not write this and does not trust it.
Date: 2026-09-10 · Branch: `claude/mannon-b2b-wholesale-oc5b18`

## 1. Test plan

Spec re-read: `feature-checklist.md` §3 (✦ Screening states, the reject flow's
drafted email, ✦ Segment builder) and §2 (✦ CSV whisperer, the mapping screen);
`pages-features.md` §2–3; `brand.md` §5 (dual-mode, temperature 0, ids validated
against the live catalogue, "Claude drafts, you send").

Four features, one shared question: **what leaves, and what is believed on the
way back.** These are the first AI paths handed real data about real people, so
the plan is built around that rather than around happy paths.

**States required by the checklist:**

| Feature | State | Capture |
|---|---|---|
| Screening | pending — "checking", never blocking | `ai-01-screening-waiting` |
| Screening | Recommend approve + 3 reasons | `ai-02-screening-recommend` |
| Screening | Needs a look + reasons | `ai-03-screening-look` |
| Screening | screening failed → neutral, never blocks | `ai-04-screening-unavailable` |
| Screening | Arabic | `ai-05-screening-arabic` |
| Drafted email | drafted, with the trust line | `ai-06-email-drafted` |
| Drafted email | draft failed → merchant's own template | `ai-07-email-draft-failed` |
| Segments | composing | `20-segments-composing` |
| Segments | no key — composer off | `21-segments-no-key` |
| Segments | model failure | `22-segments-timeout` |
| Segments | chips + live count + members | `23-segments-draft` |
| Segments | zero results, tightest chip named | `24-segments-empty` |
| Segments | ambiguous group | `25-segments-clarify` |
| Segments | duplicate name | `26-segments-duplicate-name` |
| Segments | Arabic · saved list | `27`, `28` |
| CSV whisperer | mapping screen, confidence per column | `ai-10-csv-mapping` |
| CSV whisperer | required column unmatched | `ai-11-csv-mapping-missing` |
| CSV whisperer | no key — map it yourself | `ai-12-csv-mapping-no-key` |
| CSV whisperer | Arabic | `ai-13-csv-mapping-arabic` |

**Three abuse cases I invented:**

1. **A model answering outside its vocabulary.** An invented screening signal
   (`looks_dodgy`), a verdict of "reject", a segment condition field this app
   has never heard of, a CSV column that is not in the template, two headers
   mapped to one column, an email merge tag the send path cannot fill.
2. **A tampered payload.** A segment draft with no provenance, choices whose
   values are not strings, a group id belonging to another shop pushed in as an
   answer to a chip.
3. **Wrong-tenant access.** Screening another shop's applications; counting,
   saving and deleting segments across shops; segment members from another
   shop's customers.

## 2. Automated

New:

- `tests/unit/screening.test.ts` — 19
- `tests/unit/segments.test.ts` — 30
- `tests/unit/csv-mapping.test.ts` — 14
- `tests/unit/email-draft.test.ts` — 11
- `tests/unit/segments-page-states.test.tsx` — 13 (+9 captures)
- `tests/integration/screening.test.ts` — 12
- `tests/integration/segments.test.ts` — 18
- `tests/unit/applications-page-states.test.tsx` — 9 added (+7 captures)
- `tests/unit/pricing-pages-states.test.tsx` — 5 added (+4 captures)

**Whole suite: 1,472 unit + integration across 78 files, green.**
`npx playwright test`: 265 e2e, green. `npm run lint`, `npm run typecheck`,
`npm run build`, `npm run format:check` clean. No secret and no prompt in the
client bundle — grepped after a real build.

Properties worth naming:

- **The screening prompt has nowhere to put a person.** Asserted on the shape of
  `ScreeningFacts` and on a real submission's assembled facts: the applicant's
  email address and first name appear nowhere in the serialised facts.
- **A mapped CSV still imports.** `applyMapping` → `planImport` end to end, with
  the row numbers intact so the error report still points at the merchant's file.
- **The count and the members agree.** `previewSegment().count` equals
  `segmentMemberIds().length` for the same conditions.

## 3. States, walked

`npm run qa:capture` renders each state and screenshots it into this directory.
Twenty states, including Arabic for all three new surfaces.

**What this proves:** which content and which states render, and that no raw
catalog key reached the page. **What it does not prove:** what a merchant sees —
Polaris `s-*` elements do not upgrade here, so every capture's styling is a
stand-in. No visual pass has happened, here or anywhere.

## 4. Boundary

- **Screening is per shop.** A run in shop α leaves shop β's applications
  `WAITING`; α's are stamped.
- **Segments are per shop.** Counting, previewing and member lists see only this
  shop's customers; two shops may use the same segment name; deleting another
  shop's segment reads as not found (a 404 `Response`), never as a leak.
- **A forged group id from another shop does not resolve.** It comes back as an
  unanswered chip, and the id appears nowhere in the conditions.
- **A draft payload with no provenance is refused**, so an audit entry's model
  and prompt version cannot be forged into existence by a hand-edited field.

## 5. Invariants

1. **Every price comes from the engine.** Nothing here prices anything. A
   segment is a filter; applying one to a rule goes through `createRule`.
2. **Every query is shop-scoped.** §4.
3. **AI drafts; a person approves.** Screening writes a *recommendation* and
   never touches `status` or `decidedAt` — asserted. The email draft returns
   text; sending is the merchant's click and the existing audit path. Saving a
   segment records `aiAssisted` with the approving user, and `recordAudit`
   refuses it without one. Every call has the 4.1 timeout, one retry, and a
   manual path: the queue decides without screening, the panel opens on the
   merchant's own template, the mapping screen is fully usable with no key.
4. **Nothing claims to have happened that did not.** `WAITING` / `UNAVAILABLE` /
   `OFF` are three different sentences and none of them is "we looked and it is
   fine". A saved segment's count is shown "as of" a date. The website is
   compared, not fetched, and the copy says so. No merchant text in the run log.
5. **Deciding shows its working.** Every screening reason is a code tied to a
   fact the app holds, rendered from our catalogue; every segment condition is a
   chip the merchant can read and remove; every column mapping shows its
   confidence and the sample values behind it.

## 6. Bugs found, and fixed

1. **Five routes discarded everything their action computed.** `useLoaderData`
   alone was read while the action returned `json({ view })` — and in Remix a
   non-redirect action response re-runs the loader, so the action's view never
   rendered. This meant `app.pricing.new` and `app.pricing.$id` showed an *empty
   builder with no errors* on a validation failure, `app.pricing.csv` never
   showed its dry-run report, `app.pricing.settings` lost its trace, and 4.2's
   ✦ draft could never appear at all. Shipped in 1.3 and copied in 4.2. All five
   now read the action's view; `app.orders.terms` had it right and is what the
   fix follows.
2. **Two of those routes returned a partial view** (`{ view: { issues } }` with
   no `form`), which would have crashed the builder once it was actually
   rendered. Both now echo the whole form with the issues beside the fields.
3. **`s-button` carries no `name` or `value`** — confirmed against
   `@shopify/polaris-types` and Shopify's own AI Toolkit skill — so a second
   submit in one form silently posts the first intent. The ✦ draft-email control
   became a link the loader handles, and the draft writes around `{{reason}}`
   so it reads correctly whichever reason the merchant picks.
4. **A test form keyed a field `website`**, which is the honeypot key
   (`app/lib/forms/spam.ts`), so every submission was silently dropped as spam.
   Not a product bug — `RESERVED_KEYS` blocks it at publish — but it is why
   `websiteDomainIn` scans every answer rather than one key, and the test now
   says so.

## 7. Open, not passed

- **No call has ever been made to Anthropic.** No key here. Every path is driven
  through an injected `MessagesApi`; request shapes are pinned, responses are
  stubs.
- **No visual pass**, as since 0.1.
- **No screening has ever run against a real application**, because that needs
  both a key and a dev store.
- **Streaming**: the segment builder shows chips after the answer, not during
  it, for the reason recorded in `DECISIONS.md` on 2026-09-10.

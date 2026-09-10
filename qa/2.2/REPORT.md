# QA report — 2.2 · Registration form builder, theme block, VIES, spam protection


Reviewed as someone who did not write it and does not trust it.

### 1. Test plan

The spec: checklist §4 (forms list, builder, storefront form) and
pages-features §4. ✦ Form-from-a-prompt is 4.3; the approval queue the
applications land in is 2.3. This task owns the builder, the two ways a buyer
reaches a form, and everything that happens between submit and a stored
application.

Happy paths: a merchant takes a template, edits fields, sets a condition,
picks colours, publishes; a buyer opens the link, fills it in and applies; the
merchant sees the application and can open the attached licence.

Invented abuse cases:

1. **Malformed input.** A submission carrying keys the form does not have, a
   5,000-character company name, `privacy=false` as a hand-made post, a hex
   colour that is not a colour, a redirect of `javascript:alert(1)`, a width of
   `-5`, a stored definition whose fields are a string.
2. **Concurrency and abuse of the public endpoint.** Six applications from one
   address in an hour; a form submitted in under three seconds; a filled
   honeypot; a 6 MB upload; an `.xlsx` renamed to look like a licence.
3. **Wrong shop.** Reading and archiving another shop's form by id; a public
   form id resolving into the wrong tenant's data; one shop's applications
   appearing in another's list.

### 2. Automated tests

`npm test` — **679 tests, 35 files, all passing** (564 at 2.1). New:

- `tests/unit/forms-schema.test.ts` (51) — the pure modules: definition
  validation including two- and three-field condition loops, visibility
  resolution, every field kind's validation, merge tags, WCAG contrast against
  known ratios, appearance clamping, redirect safety, VAT shapes per country,
  and every spam signal.
- `tests/integration/forms.test.ts` (37) — CRUD, slug collisions, duplicate as
  a draft, publish gating, quota, the whole submission pipeline, uploads, the
  four spam paths, six VIES cases, and five tenant-isolation cases.
- `tests/unit/forms-pages-states.test.tsx` (27) — every state below.

`npx playwright test` — **140 passing** (100 at 2.1), including a new
`tests/e2e/public-form.spec.ts` (16). This is the first surface in the project
that can be driven for real: it is our own page on our own domain, so the
buyer's form is exercised in Chromium **with JavaScript switched off** —
rendering, submitting, failing validation, and the conditional field.

Lint, `tsc --noEmit`, `npm run build` and `prettier --check` are clean.

### 3. State walkthrough

23 states captured to `qa/2.2/`. Forms list: empty with the three templates,
ideal, a form nobody has opened, a form with problems, over quota. Builder:
configuration with keyboard reorder and the VAT example, no fields, issues,
appearance passing contrast, the grey the checklist names failing, a colour
that is not a colour, the four emails, a test send with no sender, publish,
publish blocked, applications with an unscanned upload. The buyer's form:
ideal, errors, a file too large, a file of the wrong type, boxed with the
merchant's colours, Arabic, Arabic errors.

The seven buyer-facing captures are labelled **"the real page"** rather than
"structure only": that screen is plain HTML styled by the merchant's own
appearance settings, so unlike the Polaris screens the capture is what a buyer
actually sees. Reusing the standing disclaimer there would have understated
what had been checked.

### 4. Cross-tenant check

The public form lookup is the one query in this feature that must cross
tenants — a public URL carries no shop — so it selects by an unguessable
`publicId`, returns the shop, and every subsequent query runs inside that
shop's scope. Asserted: an application lands in the shop that owns the form
rather than the caller's; another shop's form reads as not found and cannot be
archived; one shop's applications never appear in another's list; an archived
form is not reachable publicly at all. Uploads are behind the admin session and
the scope, so a trade licence uploaded to one store cannot be fetched by
another or by a stranger holding the id.

### 5. The three musts

| Rule                                           | Status at 2.2                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| No price from outside the pricing engine       | Held, and no price appears on any screen in this task.                                                                                                |
| No AI mutation without an approval record      | Held. ✦ Describe your form is rendered disabled and its action is a no-op, so a hand-made request gets the same answer rather than a half-built path. |
| No unhandled promise rejections in the e2e run | Clean. The public-form spec fails on any page error, and the only stack trace in the server log is the deliberate 404 test.                           |

### 6. Bugs found and fixed

1. **The form lost everything a buyer typed, and said nothing.** Without
   JavaScript a submit is a document POST: Remix runs the action, then re-runs
   the loader and renders. The page read only `useLoaderData`, so a validation
   failure came back as a blank form with no errors and no answers — the exact
   state the checklist asks for, inverted. Found by the no-JS end-to-end test on
   its first run; nothing in the unit tests could have caught it, because the
   component was correct and the wiring was not.

2. **The Arabic form had an eleven-thousand-pixel horizontal scrollbar.** The
   honeypot was hidden with `left: -9999px`, which in a right-to-left document
   overflows the page rather than leaving it. Found by looking at the capture —
   the PNG was 11,099px wide. Clipping (`clip-path: inset(50%)`) hides it in
   both directions and creates no scrollable area. There are now four e2e
   assertions that neither language scrolls sideways, on desktop and on mobile.

3. **The buyer's form crashed on any validation error.** The view carried its
   strings as an object with a function on it, and a function does not survive
   the JSON boundary between a loader and a component — so the first call to it
   threw the page away and rendered the error boundary. Found by the same e2e
   run. The component now translates for itself and the view carries only data.

4. **A client component imported a `.server` module.** `PublicForm.tsx` pulled
   the honeypot field names from `submissions.server`, which fails the build
   rather than shipping — caught by `npm run build`, and fixed by moving the two
   constants into the pure spam module where they belonged.

5. **A validation failure counted as a page view**, so a buyer who made a
   mistake pulled the form's conversion rate down twice. The loader now records
   a view only on a GET.

6. **The phone field rejected a bracketed area code.** `(020) 7946-0958` is how
   a large part of the world writes a number, and the pattern required a digit
   first. Found by writing the test case before looking at the regex. The
   digit count is now checked separately, so `(((((((` still fails.

Two more were mine in the tests, not the code: a publish-gating test that
passed a _valid_ definition to `updateForm` and therefore proved nothing, and a
fixture with no VAT field asserting that the VAT example rendered.

### 7. Open items

- **Not seen in a real Shopify admin, and now spanning three phases.** The
  builder is asserted markup. The buyer's form is the exception — it is
  genuinely exercised in a browser.
- **The theme block is unverified against a real theme.** It frames the app's
  own page, so nothing about it depends on Liquid metafield behaviour we cannot
  check — but no theme has ever rendered it. See ADR 0012 for why framing beat
  a Liquid re-implementation.
- **Nothing scans uploaded files.** `scannedAt` is null and the admin says "not
  virus-scanned". Downloads are attachments, `nosniff`, sandboxed by CSP, and
  behind the admin session. A scanner is a service decision, not a code one.
- **No email is sent, at all.** The templates, merge-tag validation and
  test-send button are real; the transport is a seam with nothing behind it.
  The button says so. Notification sending belongs with the approval pipeline
  in 2.3, which is what will choose a provider.
- **Auto-tags and auto-group are stored, not applied.** They are applied on
  approval, which is 2.3. The Publish tab says "on approval" rather than
  implying they happen when the application arrives.
- **Multi-step pages are not built** (parity list, not a checklist state), and
  **address autocomplete** is a plain textarea — an autocomplete needs a places
  provider, which is another service decision.
- **QR codes are not generated.** The link is copyable; a QR encoder is a
  dependency, and the checklist offers link _or_ QR _or_ theme block.
- **The applications panel is not the queue.** The Publish tab shows the last
  five so the pipeline is observable end to end; approve and reject are 2.3, and
  the panel says so.
- **`FormEvent` rows are never pruned.** Views and submissions accumulate;
  retention lands in 7.2 with the rest.

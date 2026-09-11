# Cold read — 6.4 Settings, part one

Independent adversarial review. I did not write this code and I did not trust
`qa/6.4/REPORT.md`; every claim in it was re-derived from the source, the
database, a real browser and the rendered PNGs.

Commits under review: `e6a3342`, `cf22fd7` (+ `3940403`, docs only).
Branch: `claude/mannon-b2b-wholesale-oc5b18` · Date: 2026-09-11

## Verdict: **FAIL**

One P0, five P1s, nine P2s, eight P3s.

The headline defect is that **the Notifications section cannot be saved at
all**: its "Check the records" form is nested inside the section's own form, so
the HTML parser folds the two together and *every* submit in that section
carries `intent=verify` — which the route answers with an unhandled **501**.
Proven in Chromium against the shipped capture (§2, P0-1). The one field the
whole section exists to set is unreachable, and the merchant gets a crash
screen instead of a validation message.

The second story is quieter and worse for trust: **five of the nine new
columns are write-only.** `showCompareAt`, `hidePricesFromGuests`,
`taxDisplay`, `allowShopifyDiscounts` and `taxExemptNeedsApproval` are read by
nothing outside this page, while the copy beside each one promises specific
storefront and checkout behaviour ("A visitor who is not signed in sees no
price and no add-to-cart", "This is the store-wide gate"). The storefront
blocks still strike through the retail price for a merchant who switched that
off. That is Invariant 4 five times over, on a page whose entire subject is
"what this change affects".

And the pause the task was proudest of is **atomic in one direction only**. A
failed publish during *resume* leaves the admin saying rules are live, our own
code pricing wholesale in quotes and the agent, and Shopify's metafield empty
— trade buyers quoted wholesale and charged retail. Reproduced (§2, P1-3).

The mechanical gate is genuinely clean and I re-ran all of it. Three of the
report's own claims check out exactly as stated, including the "watched it go
red" claim for the pause tests (§3). The gate is not lying; it is testing the
world the fixtures describe.

---

## 1. What was run

| Command | Result |
| --- | --- |
| `pg_isready` | accepting connections |
| `npm test` | 111 files, 2,069 tests, green (121 s) |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `npm run format:check` | clean |
| `npx playwright test` (after a fresh build) | 399 passed, 0 unhandled rejections in the log |
| Client-bundle scan (`sk-ant`, `SHOPIFY_API_SECRET`, `ANTHROPIC_API_KEY`, `RESEND`, `MANNON_EMAIL_FROM`, `DATABASE_URL`) over `build/client` | nothing |
| `md5sum qa/6.4/*.png` | 12 files, 12 distinct hashes — the distinctness claim holds |
| All 12 PNGs opened and read as pictures | §4 |
| Chromium parse of `qa/6.4/06-sender-unchecked.html` | **6 forms, not 7 — see P0-1** |

Everything below was reproduced with a throwaway probe suite under
`tests/integration/`, run against `mannon_test`, and deleted afterwards. The
tree is unmodified; `git status` is clean.

---

## 2. Findings

### P0-1 — The Notifications section can never be saved; Save returns 501

**Where:** `app/components/settings/SettingsPage.tsx:382` (the verify `<form>`)
nested inside `Section`'s `<form method="post">` at `:68`; route
`app/routes/app.settings.tsx:58-62`.

`SenderStatus` renders its own `<form>` *inside* the section form, to carry
`intent=verify` on a hidden input. Nested forms are not legal HTML: the parser
ignores the inner `<form>` start tag, so both hidden inputs join the **outer**
form. Run against the capture this repo shipped:

```
$ node … chromium → file://qa/6.4/06-sender-unchecked.html
{ "formCount": 6,                       // the verify form does not exist
  "notifFields": ["section=notifications","section=notifications","intent=verify"] }
```

Six sections, six forms. The Notifications form's own FormData contains
`intent=verify`.

**What breaks for a merchant:** they type `orders@acme.com`, press **Save**,
and the action reads `intent === "verify"` before it ever reaches
`saveSettings`, throwing `new Response("Sender verification is not
configured", { status: 501 })`. `boundary.error` renders the generic embedded
error screen — no field message, no explanation, and the address is never
written. There is no other way to set a sender address in the app, so
`senderEmail` is unreachable in production and every state past `none` is
unreachable with it (see P2-4). Both buttons in that section do the same
nothing.

**Reproduce:** load `/app/settings`, type anything into "Send from", press
"Save" in the Notifications card. Or, offline: the Chromium snippet above.

**Why no test caught it:** `settings-page-states.test.tsx` asserts on the HTML
string, which contains a `<form>` that no browser will build; and
`tests/integration/settings.test.ts` calls `saveSettings` directly with a
hand-made `FormData`, which skips the form the merchant actually posts. Nothing
drives this page in a browser.

---

### P1-1 — Five of the nine new settings are write-only; the copy promises behaviour that does not exist

**Where:** `app/lib/settings/settings.server.ts:117-132`; readers absent.

`grep` for every consumer of the new columns outside `app/lib/settings/` and
`app/components/settings/`:

| Column | Read by | The copy the merchant is shown (`en.json`) |
| --- | --- | --- |
| `showCompareAt` | nothing | "Off if your trade buyers should never see the retail price." |
| `hidePricesFromGuests` | nothing | "A visitor who is not signed in sees no price and no add-to-cart…" |
| `taxDisplay` | the preview on this page only | "Show prices as … Excluding/Including tax" |
| `allowShopifyDiscounts` | nothing | "Each rule still decides for itself. **This is the store-wide gate.**" |
| `taxExemptNeedsApproval` | nothing | "Off means an application that meets your criteria is exempted without anyone looking." |

Concretely:

* **Compare-at.** `app/routes/proxy.variants.tsx:112` and
  `app/lib/storefront/quick-order.server.ts:226` always return `wasPrice`, and
  `extensions/mannon-storefront/blocks/variants-table.liquid:188` and
  `quick-order.liquid:176` always render it struck through. A merchant who
  turns the setting off — the one thing that copy promises — still shows every
  trade buyer the retail price on both blocks.
* **Discount stacking.** The only place combination is configured is
  `app/lib/pricing/ruleset.server.ts:141`, hardcoded
  `{orderDiscounts:true, productDiscounts:false, shippingDiscounts:true}` — and
  only inside `ensureDiscount`, which returns early once a `discountId` exists,
  so it is never revisited. Turning "Allow Shopify discount codes on wholesale
  prices" on changes nothing at checkout. The section even carries a warning
  banner and a rules count, which makes the merchant *more* confident in a
  control that is inert.
* **Guests.** Nothing in the theme blocks or the proxy consults
  `hidePricesFromGuests`; guests keep seeing the theme's retail price and
  add-to-cart.
* **Tax exemption approval.** `app/lib/customers/customers.server.ts:311` reads
  `requireVatForTaxExempt` and nothing reads `taxExemptNeedsApproval`.

This is Invariant 4 — "nothing claims to have happened that did not" — on five
controls at once. Either wire them, or say on the page that they take effect
when the storefront/checkout work lands. Silence is the one option that is not
available.

---

### P1-2 — A failed publish during **pause** leaves the page claiming a pause that did not reach checkout

**Where:** `app/lib/settings/pause.server.ts:50-56`.

Probe (fake admin whose `graphql` throws):

```
pause with failing publish -> threw: Error: Shopify is down;
  pausedAt=2026-09-11T…;  view.paused=true;  audit rows: (none)
```

`pausedAt` is written first, the publish throws, and nothing rolls back or
retries. The merchant sees the generic error screen, comes back to
`/app/settings`, and reads the banner this task added: **"Mannon is paused. No
wholesale price is being applied anywhere."** Shopify's metafield still holds
the live ruleset, so every checkout is still discounted. `docs/adr/0026`
argues this is the safe direction because our own code has already stopped —
but the sentence on the screen is not about our own code, it says *anywhere*,
and this is the one control whose whole value is being believed in a hurry.

Aggravating: **no `AuditLog` row is written** (it comes after the publish), so
the app is paused with no record of who paused it — Invariant 5 on the most
consequential action on the page.

**Minimum fix shape:** treat the publish as part of the operation — retry, or
record `pausedAt` only after a successful publish and show a "paused here, not
yet at checkout" state driven by `rulesetRuleCount` if it cannot complete.

---

### P1-3 — A failed publish during **resume** is worse: wholesale in the quote, retail at the till

**Where:** `app/lib/settings/pause.server.ts:76-82`.

```
resume with failing publish -> threw: Error: Shopify is down;
  pausedAt=null;  engineRules=1;  rulesetRuleCount=0;
  view says paused=false, ruleCount=1
```

The flag clears first. So after a failed resume: the paused banner is gone,
the danger zone says "Pausing stops 1 pricing rule from applying" (i.e. it is
applying), `activeEngineRules()` returns the rule again — so quotes, PO-to-
order, the Buyer Agent and the admin preview all quote wholesale — and the
metafield at Shopify is still the empty one, so **checkout charges retail**. A
buyer is quoted £X and billed £Y. It self-heals only when somebody next edits
a rule.

The ADR reasons about pause only. Resume has the same two-step and its failure
mode is the dangerous direction by any reading.

---

### P1-4 — The storefront preview invents a price and labels it "A buyer will read:"

**Where:** `app/lib/settings/view-model.server.ts:24` and `:26-44`.

```ts
const SAMPLE = { retail: 4_000, wholesale: 2_800 };
```

The preview renders `$28.00` struck through `$40.00` under the label **"A
buyer will read:"**. The wholesale figure is a hardcoded 30 % off that came
from no rule of this merchant's and did not pass through `resolvePrice`.
Invariant 1 is absolute — "a number that looks like a price and did not come
from the engine is a bug" — and Invariant 4 applies too: nothing on the card
says these are made-up figures. Compare `previewFor`
(`app/lib/pricing/view-model.server.ts:272`), which runs the real engine for
the rule builder's preview.

Visible in `qa/6.4/01-settings.png` and, more damningly, in
`qa/6.4/11-danger-paused.png`: the app is paused, no buyer is getting a
wholesale price anywhere, and the card still says a buyer will read $28.00.

**Fix shape:** label it "Example" and/or drive the two numbers through the
engine with the merchant's own highest-priority rule, and blank it while
paused.

---

### P1-5 — `senderVerifiedAt` and `senderDnsRecords` have no writer, so two of the four sender states are unreachable — and the tests assert them by hand-setting the columns

**Where:** `app/lib/settings/view-model.server.ts:53-72`;
`tests/integration/settings.test.ts:344-378`.

No code path anywhere writes `senderVerifiedAt`, `senderCheckedAt`,
`senderCheckError` or `senderDnsRecords` except the *clearing* branch in
`saveSettings:189`. So in production:

* `verified` (capture `08-sender-verified.png`) can never happen;
* `failed` (capture `07`) can never happen;
* the DNS records table (captures `06`, `07`, `08`) is always empty, so a
  merchant who sets an address is shown "Not checked yet", **no records to
  add**, and a button that 501s.

The integration test reaches `verified` with
`db.shop.update({ data: { senderVerifiedAt: new Date() } })` — precisely the
"fixture sets a column the production writer never sets" shape `PROGRESS.md`
warns about three times. It is a test that cannot fail.

The blocked-on-a-provider-key framing in `REPORT.md` §8 is fair for the *check
itself*. It is not fair for the report's claim that "the records table and the
fallback copy are all built and driven", nor for shipping three captures of
states no merchant can reach without saying so beside them. Checklist §8 asks
for "DNS records shown **copy-able**" — there is no copy affordance anywhere in
the repo, so that clause is unimplemented as well as unreachable.

---

### P2-1 — "Check the records" is enabled whenever `MANNON_EMAIL_FROM` is set, and always crashes

**Where:** `view-model.server.ts:149` (`verifiable: emailSender() !== null`);
`SettingsPage.tsx:386`; `app.settings.tsx:58`.

`emailSender()` is `process.env.MANNON_EMAIL_FROM` — "we have a From address",
which is a different claim from "a provider can verify a domain". Any real
deployment sets that variable, so the button renders **enabled**, the
"No mail provider is connected…" explanation is suppressed (it is rendered
only when `!verifiable`), and pressing it returns the same unhandled 501 as
P0-1. Convention: "Errors are user-facing copy: say what went wrong and how to
fix it, next to the cause." A 501 error boundary is none of those.

The report's Invariant-4 paragraph — "with no provider, Verify is disabled with
the reason beside it" — is true only for the environment that happens to have
`MANNON_EMAIL_FROM` unset, which is this one.

---

### P2-2 — The reminder note is false: changing the setting moves the date on quotes already sent

**Where:** copy `settings.orders.outstanding_*`; behaviour
`app/lib/jobs/handlers/expire-quotes.server.ts:58` →
`app/lib/quotes/state.ts:131`.

The page says, under both quote fields: *"5 quotes are already out. Their dates
were fixed when they were sent and this does not move them."* True for
`quoteExpiryDays` (copied onto the row at send, `quotes.server.ts:350`). **Not
true for `quoteReminderDays`**, which the expiry job reads live from the `Shop`
row for every `SENT` quote. Raising it from 3 to 10 makes every outstanding
quote inside ten days of expiry immediately due — a burst of "your quote is
expiring" mail to buyers, the exact thing the sentence promises will not
happen. Lowering it silently skips reminders that were due.

---

### P2-3 — The buyer count is case-sensitive while the rest of the app is not

**Where:** `view-model.server.ts:93` —
`db.customer.count({ where: { tags: { has: shop.wholesaleTag } } })`.

Every other tag comparison in the app lowercases:
`app/lib/jobs/handlers/backfill-customers.server.ts:55`,
`app/lib/orders/sync.server.ts:590`,
`packages/pricing-engine/src/eligibility.ts:16`,
`app/lib/customers/tagging.ts:96`. Probe: shop tag `Wholesale`, buyer tagged
`wholesale` → **`taggedBuyers: 0`**, while the pricing engine prices that buyer
as wholesale.

So the field whose only job is to warn — "34 buyers carry the current tag and
would stop being recognised" — can read `0` for a shop with hundreds of trade
buyers, and a merchant renames the tag believing nobody is affected. The
integration test at `tests/integration/settings.test.ts:325` uses matching case, so it cannot see this.

---

### P2-4 — "See which rules" goes to an unfiltered list

**Where:** `view-model.server.ts:124` → `/app/pricing?combinable=1`;
`app/routes/app.pricing._index.tsx:29-33`.

The Pricing loader reads `archived`, `search`, `page` and `sort`. There is no
`combinable` parameter, in the loader or in `listRules`
(`app/lib/pricing/rules.server.ts:94`). The link lands on the full rule list,
which also includes drafts and paused rules, so a merchant told "this affects 3
active rules" is shown seven rows and cannot check the number by hand.

Invariant 5 is half-done, and the component's own comment ("a number a merchant
cannot check is a number they have to take on trust") describes what actually
ships. The state test only asserts `html).toContain("/app/pricing?combinable=1")`,
which is true of a link that does nothing.

---

### P2-5 — There is no save bar and no unsaved-changes guard

**Where:** `SettingsPage.tsx:71-74`.

`<ui-save-bar>` is inert markup unless something calls `.show()` on it or the
form carries App Bridge's `data-save-bar`. Nothing in this repo does either
(`grep -rn "saveBar\|\.show()" app` → nothing). So what ships is a plain
"Save" button per card, no "Unsaved changes / Discard / Save", and **no guard
against navigating away with unsaved edits** — a repo-wide gap (six components
do this), but 6.4 adds six more instances and both `REPORT.md` §1 and the
component docstring claim checklist §8's "each section its own card page with
save bar" as met. It is not met. Six save bars on one route is also wrong on
its own terms: the contextual save bar is a singleton overlay.

---

### P2-6 — A failed save throws away what the merchant typed

**Where:** `app/routes/app.settings.tsx:69-80`.

The 422 branch rebuilds the view with `settingsView()`, which reads the `Shop`
row, so every field renders its **stored** value while the error message
renders beside it. `qa/6.4/04-settings-error.png` shows it: "Shopify splits
tags on commas…" under a field containing `wholesale`. The merchant cannot see
the `trade,vip` they typed, cannot fix it, and cannot tell which of the two
tag fields was at fault except by the error's position. Multi-field sections
(orders, display) lose every edit in the section, not just the bad one.

---

### P2-7 — Two pages own `posBypassesLimits`, and they parse the same checkbox two different ways

**Where:** `app/routes/app.orders.limits.tsx:232`
(`form.get("posBypassesLimits") !== null`) vs
`app/lib/settings/settings.server.ts:94` (`form.get(key) === "on"`), both
reading an `s-checkbox name="posBypassesLimits"`.

One of these is wrong about what a Polaris `s-checkbox` submits. Polaris's own
types document `value` as "the value used in form data when the checkbox is
checked" with **no documented default** (`@shopify/polaris-types`,
`BaseCheckableProps`), and no `value` is set on any checkbox in this app. If
the upgraded component submits anything other than the literal string `on` —
`"true"`, `""`, the label — then **every checkbox in Settings silently saves as
off** and the page will show it unticked afterwards, which reads as data loss,
not as a bug. Probe: posting `showCompareAt=true` stores `false`.

This cannot be settled in this environment (no Polaris), which is exactly why
it should be written down: use the presence test that the Orders page already
uses, or set an explicit `value="on"`, and say in the report that the
assumption is unverified.

---

### P2-8 — Nothing outside this page says the app is paused

**Where:** `pausedAt` readers: `proxy.server.ts:158`, `rules.server.ts:137`,
the settings view. Nothing else.

While paused: the Pricing list still badges every rule **Active**, the rule
builder's preview still shows "was $40 → now $28"
(`pricing/view-model.server.ts:272` prices the draft "as if live"), the quote
builder prices every line at retail with `ruleSummary: null` and no reason
given, and PO-to-order converts at retail. The Home page says nothing. The
component comment at `SettingsPage.tsx:19` — "Not only on this page" — is the
opposite of what ships: it is *only* on this page.

For quotes this is not cosmetic: `priceQuote` **locks** the prices it
computes, so a merchant who prices a quote during a pause permanently locks
retail prices into it with no explanation on screen. Invariant 5.

---

### P2-9 — Pausing a shop that has no discount yet creates one

**Where:** `pause.server.ts:56` → `publishRuleset` → `ensureDiscount`
(`ruleset.server.ts:120`).

Probe with `discountId: null`: pausing issued **3 Admin API calls** and left
`discountId = gid://shopify/Discount/1`. So the act of switching the app off
creates a live automatic discount object in the merchant's Shopify admin. And
when no Function is deployed, `resolveFunctionId` throws *"No deployed discount
Function found for this app. Run `shopify app deploy` first"* — the merchant
cannot pause, gets that developer-facing string on an error screen, and
`pausedAt` is set anyway (P1-2).

---

### P3s

1. **`readDays` accepts hex and signed forms.** `settings.server.ts:63` —
   `Number("0x10")` is 16, so a reminder of `0x10` stores **16 days**; `"+9"`,
   `"007"`, `" 7 "` likewise. `"7.5"`, `"1e3"`, `"٧"`, `"Infinity"`, `""` are
   correctly refused, and `reminder >= expiry` (including equal) is refused.
2. **The email check accepts markup.** `LOOKS_LIKE_EMAIL` accepts
   `<script>alert(1)</script>@x.co` and stores it as the sender (React escapes
   it on render and `\s` blocks header injection, so this is tidiness, not a
   hole). It rejects quoted locals (`"a b"@x.co`) and single-label domains.
3. **`?saved=<section>` fakes a confirmation.** `app.settings.tsx:30` passes
   the query parameter straight through, so any link with `?saved=tax` renders
   "Saved." under a card where nothing was saved.
4. **The audit summary over-counts.** Changing one address logs "Changed 2
   notifications settings" because the derived `senderDomain` counts as a
   changed key. Metadata itself is clean — section and field *names* only, no
   values, no PII (Invariant 4 holds here).
5. **The write and its audit entry are two awaits**, not one transaction
   (`settings.server.ts:193-201`), and pause/resume the same. The repo's known
   latent shape; no AI path reaches it.
6. **The confirm is client-side only.** `tests/unit/settings.test.ts:17`
   claims `isSection` stops "a plain POST pausing a shop with no confirmation",
   but `app.settings.tsx:46` handles `section=danger` *before* `isSection`, so
   a plain POST of `section=danger&intent=pause` does pause with no confirm.
   Session-authenticated, so low risk — but the test's comment asserts a
   protection that does not exist.
7. **Double pause moves the date.** Pausing an already-paused shop rewrites
   `pausedAt` and writes a second audit entry, so "Paused 1 September" can
   become today's date without anything having changed.
8. **`/app/settings` has nothing for the link that points at it.**
   `app/components/orders/LimitsPage.tsx:218` — "Change this wording in
   Settings" — now lands on a Settings page with no limit-message editor and no
   note that it is coming. It was a forward reference before 6.4; after 6.4 it
   is a dead end.

---

## 3. Claims in `qa/6.4/REPORT.md` I checked

| Claim | Verdict |
| --- | --- |
| "Whole suite: 2,069 across 111 files, green" | **True** (re-run) |
| "Playwright: 399 passed" | **True** (re-run after a fresh build) |
| "lint, tsc, build, format:check clean" | **True** (all four re-run) |
| "The three pause tests were watched fail" | **True.** I set the `pausedAt` branch in `rules.server.ts:137` to `false &&` and re-ran: 3 failed / 11 passed, with the expected `to have a length of +0 but got 2`. Restored. |
| "All 12 captures are distinct renders" | **True** — 12 distinct md5s, and they are 12 genuinely different pages |
| "No secrets in the client bundle" | **True** |
| "No PII in logs; the audit stores field names, never values" | **True** |
| "`section=danger` cannot reach `saveSettings`" | True, but see P3-6 — the route pauses without a confirm anyway |
| "A crafted body cannot write another section's field" | **True.** Every section builds a fixed literal; `__proto__`, `shop`, `"wholesale "` are all refused by `isSection`; no form field names a shop |
| "Every query is shop-scoped" | **True.** All six queries in `view-model.server.ts` and both writers go through the extension; cross-tenant probes read as not-found |
| "with no provider, Verify is disabled with the reason beside it" | **Environment-specific** — P2-1 |
| "the records table and the fallback copy are all built and driven" | **Misleading** — driven by fixtures only; no writer exists — P1-5 |
| "each section its own card page with save bar" | **Not met** — P2-5 |
| "the discount-combination count links to the rules it counted" | **Not met** — the link is unfiltered, P2-4 |
| "pause now actually stops the rules" | True for our own code; **not** for the failure paths — P1-2, P1-3 |

---

## 4. The captures

All 12 PNGs opened. They do show the states their names claim, and the
`details`/`checked` stand-in work is a real improvement — help text and tick
marks are legible for the first time, and the commit correctly re-rendered all
17 task directories (474 files), so no other set is stale. I re-read
`qa/3.1/limits-editing.png` as a control: it renders correctly under the new
rules, with one cosmetic side effect (a field with `details` now forces a line
break, so inline pairs like "Minimum/Maximum order value" sit ragged). That is
stand-in styling, not product.

What the captures show that the assertions do not:

* `01`, `11`: the fabricated preview price (P1-4), and that it survives a pause.
* `06`: the "Check the records" button rendered live and enabled (P2-1), and a
  DNS table no production shop can populate (P1-5).
* `04`: the error copy sitting under a field showing the *stored* value, not
  the rejected one (P2-6).
* All 12: no save bar anywhere (P2-5).

What a capture still cannot prove here: what a merchant sees. No Polaris, no
App Bridge, no iframe — the `s-select` even renders its raw value (`excl`)
rather than the option label. The report says this, correctly.

---

## 5. What I could not test

* Whether a real `s-checkbox` submits `on` (P2-7) — needs Polaris.
* Whether the nested-form collapse behaves identically once the custom
  elements upgrade. It will not help: the hidden `<input>`s are native and
  their owner is decided by the parser before any upgrade runs.
* Anything against a real store: the metafield write, the discount's
  `combinesWith`, the theme blocks, the 501 path as a merchant sees it.

---

## 6. Re-run required

Every finding above is reproducible from this tree. After the fixes, the gate
has to run again from step 2 — and P0-1, P1-2, P1-3, P2-3 and P2-7 each need a
test that fails today:

1. A browser-level test that submits each section's form and asserts the posted
   body (P0-1 would have been a one-line failure).
2. Pause and resume with an admin client that throws, asserting what the page
   then claims versus what is published.
3. A tag-count test with the case flipped.
4. A checkbox round-trip: render, submit unchanged, assert the stored value is
   still what it was.

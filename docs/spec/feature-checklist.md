# Mannon — Feature Checklist with States & Tiny Details
### Every feature × onboarding · empty · loading · errors · edges · AI states

**Inherited defaults (apply everywhere unless overridden):** skeleton screens shaped like the final layout (Built for Shopify CLS budget); field-level red errors beside the cause with the fix; Contextual Save Bar on all forms ("Unsaved changes / Discard / Save"); toasts for success ("Rule activated"), banners for warnings; all strings i18n'd EN/AR with RTL mirroring; locked features show teaser + Upgrade, never break; every AI action → audit log; AI down → manual path still works.

---

## 0. Install & Onboarding (Claude Setup Wizard)

**First open (the make-or-break moment)**
- OAuth → land on wizard, not an empty dashboard. Progress dots (1 of 3). Skippable at every step ("Set up manually instead").
- Step 1 chat: "Tell me about your wholesale business" — 3 suggested example answers as tappable chips for merchants who won't type.
- Step 2 preview: drafted groups + starter rule + form shown as cards with edit pencils. Nothing exists in the store yet — banner says so.
- Step 3 apply: single "Apply setup" → per-item progress ticks; partial failure keeps successes, retries failures only.
- **Empty:** n/a (wizard is the empty state of the whole app).
- **Errors:** Claude timeout → "Taking longer than usual" after 8s, manual-setup CTA after 20s. OAuth scope declined → explain which feature needs which scope, re-request.
- **Edge:** re-install remembers previous config, offers "Restore previous setup". Dev stores get sample data offer.
- **Tiny details:** app embed detection — if theme embed is off, persistent (dismissable) home banner with 1-click deep link to theme editor, live status check ("✓ detected" without page refresh). Uninstall webhook cleans PII within 48h (GDPR).

---

## 1. Home

**KPI cards**
- Empty: zeros + faded sparkline + "Waiting for your first wholesale order" microcopy; card links to the feature that feeds it.
- Loading: 4 skeleton tiles, fixed height (no CLS). Partial: "—" for metrics with <7 days of data, tooltip "Needs a week of data".
- Edge: currency switches with store currency; deltas hide (not "▲ ∞%") when the base period is zero.

**Merchant Agent briefing**
- Empty (day 1): agent introduces itself + 2 things it *will* watch once data exists.
- Loading: three shimmering line placeholders. AI down: card collapses to "Briefing unavailable — yesterday's is here"; never blocks the page.
- Ideal: max 3 items, each with one action button; item dismiss = "Don't show this type again?" (per-type mute list in Settings).
- Edge: stale (>24h) briefing shows timestamp badge; nothing new → "All quiet — nothing needs you today" (a real state, designed).
- Test: briefing never invents a metric — every number linked to its Analytics source.

**Ask Mannon bar**
- Idle: rotating placeholder examples (3, localized). ⌘J focuses.
- Streaming: inline result panel under the bar; Esc cancels; destructive intents ("delete all rules") always route to a confirm draft, never execute.
- Error: unparseable ask → "I didn't catch that — try one of these" + 3 reformulations. Rate-limited: cooldown message with seconds.

**Setup checklist**
- Persists until 6/6, then collapses to a ✓ pill (dismissable). Each item deep-links. Re-opens if embed gets disabled later.

**Recent activity**
- Empty: "Activity will appear here — orders, registrations, rule changes." Max 8 rows + "View all" → filtered log. Relative times switch to absolute after 7d. Buyer-Agent-origin rows carry ✦ chip.

---

## 2. Pricing

**Rule list**
- Empty: illustration + two CTAs side by side: "✦ Describe a rule" (primary) / "Create manually". One-line value prop.
- Loading: skeleton table 5 rows. Partial (1–2 rules): hide filter bar, show it from 3+.
- Ideal: name, type chip, targets, customers, uses·30d, status. Sort by any column; usage=0 for 30d gets ⚠ "unused" badge.
- Errors: fetch fail → retry banner keeping last cached list (marked "cached 2 min ago").
- Edge: >250 rules → virtualized list + search; duplicate names allowed but warned; archived rules tab (soft delete, restorable 30d, hard delete confirm types the rule name).
- Concurrency: rule edited by another staff since load → save shows diff + "Overwrite / Keep theirs".

**Rule builder (manual)**
- Save bar integration; leaving with unsaved changes → confirm modal.
- Validation, inline: name required (Massy shows the exact pattern — red border + "Name is required. Please input."); tiers must not overlap ("10–49 overlaps 40–60"); discount 0–100%; end date after start; at least one target and one audience.
- Live preview panel (sample product, mobile/desktop toggle) updates within 300ms of any change; preview failure never blocks save.
- Edge: variant targeted then deleted in Shopify → rule shows "1 target missing" badge (webhook-driven); rule on out-of-stock item still displays price; scheduled rule shows countdown chip ("starts in 3d").

**✦ Rule-from-a-sentence**
- States: composing → streaming draft (tiers appear as chips one by one) → draft-for-review card (terracotta border) → Approve & activate / Edit (opens builder pre-filled) / Discard.
- Low confidence: ambiguous product term → chip turns amber "which collection? [Sale] [Summer sale]".
- Margin guard runs pre-approve: any SKU below cost → red chip listing the 3 worst, "Approve anyway" requires explicit check.
- AI down: composer disabled with tooltip, manual builder untouched. Every generated rule logged with the prompt that made it.

**CSV import (incl. ✦ CSV whisperer)**
- Dropzone accepts .csv/.xlsx (≤10MB, ≤50k rows — bigger → "split the file" error with row counts).
- Flow: upload → mapping screen (AI pre-maps columns, confidence shown, every mapping editable) → dry-run report ("214 will import, 6 errors") → downloadable error CSV with row numbers and reasons → import with progress bar → summary toast + undo-import (single click, 1h window).
- Errors: unknown SKUs listed, not silently skipped; price of 0 → warning not error (may be intended); duplicate SKU rows → "last wins" notice.

**Priority & combinations**
- Drag-to-reorder list (Massy pattern); conflict explainer: any product search box → "Why this price?" trace showing rule cascade. Combination toggle with the exact warning Sami shows ("combining may reduce price to zero — review carefully").

---

## 3. Customers

**Pending approvals**
- Empty: "No applications waiting. Share your form →" (copy-link button).
- Loading: 3 skeleton rows. Row = company, contact, submitted-ago, ✦ screening verdict, actions.
- ✦ Screening states: pending (shimmer "Checking website & VAT…" ≤10s), Recommend approve (green + 3 reasons), Needs a look (red + reasons), screening failed → neutral "Screening unavailable — review manually" (never blocks approve).
- Approve flow: choose group + terms in the same popover (default from form's approval logic); sends templated email (editable before send — "Edit email" link); undo within 10s toast.
- Reject flow: requires reason (dropdown + free text); ✦ drafts the rejection email in brand voice; option "block this email domain".
- Edge: duplicate application (same domain) → merge suggestion; applicant already a retail customer → "Convert existing customer" path preserving history.

**Approved buyers list**
- Empty: CTA to import CSV or approve first application. Columns: company, group chip, terms, lifetime spend, last order (+ ✦ "due to reorder" chip when prediction fires).
- Search: name/email/tag; filters: group, terms, tax-exempt, at-risk. >1k rows → server pagination 50/page.
- Row actions: change group (re-prices next session — tell the merchant that), edit tags (autocomplete existing), add internal note (visible to staff only), mark tax-exempt (requires VAT id if Settings say so).
- Edge: customer deleted in Shopify → row greyed with "deleted in Shopify" chip until webhook cleanup; group deleted → members fall back to tag-only pricing with banner.

**Customer groups**
- Empty: two starter templates (Silver/Gold) one-click. Group page = bundle view: pricing rules, limits, terms, shipping, visibility attached — each section links to its source feature.
- Guard: deleting a group with members → must pick a destination group first.

**✦ Segment builder**
- Query streamed to visible filter chips (spend > $5k · last order > 45d) — chips editable after generation (AI output is inspectable, not a black box).
- Result count live; zero results → "No one matches — loosen which condition?" with the tightest condition highlighted. Save segment → named, reusable in Pricing audiences.

---

## 4. Forms

**Forms list**
- Empty: Clay-style illustrated empty state + "✦ Generate form" primary / "Start from template" secondary (3 templates: minimal, standard, strict-verification).
- Card per form: status (Draft/Live), submissions·30d, conversion %, last edited. Only one form per URL slug; duplicating appends "-copy".

**Builder**
- Tabs: Configuration / Appearance / Emails / Publish (Clay's proven IA).
- Field palette: text, email (format validated), phone (intl picker, default from store country), company, address (autocomplete), VAT (VIES live check with per-country format hint), file upload (pdf/jpg/png ≤5MB, virus-scanned, preview thumbnail), select, checkbox, years-in-business (number, min 0).
- Drag-reorder with keyboard support; required toggle per field; per-field help text; conditional logic ("show License upload when Country = KSA") with circular-dependency guard.
- Appearance: layout default/boxed, width px (clamped 320–1200), font, colors with WCAG AA contrast checker inline ("this grey fails on white — fix").
- Emails tab: confirmation / approved / rejected / needs-info templates; merge tags ({{first_name}}, {{company}}) with invalid-tag validation; test-send to self button.
- Publish: link, QR code, or theme block; redirect-after-submit URL (validated); spam protection on by default (honeypot + rate limit per IP).

**Storefront form (buyer side)**
- Loading: SSR — form renders without JS; JS enhances.
- Validation: inline on blur, summary on submit, focus jumps to first error, errors announced to screen readers.
- Success: confirmation page + email; duplicate submission (same email) → "Already applied — check status" instead of silent dupe.
- Errors: file too big (size shown), VIES down → accept VAT unverified with internal flag (never block the applicant on a third-party outage).
- Edge: submission mid-theme-change keeps working (block is version-pinned); RTL layout mirrors correctly including the file-upload control.

**✦ Form-from-a-prompt**
- Draft appears field-by-field in builder (streaming); approval logic written back in plain English above the builder ("auto-approve if VAT valid AND years ≥ 2") — editable as text, re-parsed on save with diff confirm.
- All copy + translations generated; merchant reviews AR strings before publish (never auto-publish a language the merchant hasn't seen).

---

## 5. Orders

**Wholesale orders list**
- Empty: "No wholesale orders yet — they'll appear when an approved buyer checks out." + link to test-order guide.
- Row: order #, buyer, placed-via chip (Storefront / Quick order / ✦ Buyer Agent / Draft), payment status (Paid / Net-X due date / Overdue red), total. Overdue rows float to top by default sort.
- Edge: refunds/partial refunds reflected; order edited in Shopify admin → resync badge.

**Order limits**
- Empty state explains with examples ("e.g. minimum $200 per order for Silver"). Limit editor: min/max order value, min/max quantity, quantity increments — per group, market-aware; conflicting limits (min > max) blocked inline.
- Storefront behavior spec'd per state: under minimum → cart notice + disabled checkout with exact gap shown ("Add $38 to reach your $200 minimum" — the WPD-style dynamic message, editable template in Settings → Limit display).
- Edge: guest hits wholesale-only limit → no message (limits only apply to tagged buyers); POS orders bypass toggle.

**Net payment terms**
- Setup: per group or per customer (customer overrides group, shown with "overridden" chip). Terms: 15/30/60/90/custom days.
- Checkout: "Pay later (Net 30)" button — only for eligible logged-in buyers; ineligible see nothing (not a disabled button).
- Ledger: outstanding table with aging buckets (current / 1–15 / 16–30 / 30+), overdue rows red, reminder email button (✦ drafts, merchant sends; auto-remind opt-in per buyer).
- ✦ Risk signal: chip per buyer (on-time streak / 2 late payments); suggested action only, never auto-changes terms.
- Edge: buyer at credit limit → agent and checkout both say so with the same number; partial payments recorded; terms changed mid-outstanding-invoice → applies to new orders only (stated in UI).

**Draft orders & quotes**
- Quote request (from storefront/agent) → lands here as card: requested items, buyer context (tier, history), ✦ suggested response with margin floor check.
- States: New → Drafted → Sent → Accepted/Expired (auto-expire configurable, default 14d, reminder at 3d before).
- Send → buyer gets email with pay/accept link; accepted quote converts to draft order with prices locked even if rules changed since (locked-price chip).

**✦ PO-to-order**
- Dropzone: pdf/xlsx/csv/eml ≤10MB. Parsing: streaming line-match display; each line = matched SKU + contract price + confidence.
- Ambiguous lines amber with SKU picker ("blue mugs" → 2 candidates with thumbnails); unmatched lines listed, never dropped silently.
- Totals always recomputed from Mannon rules — never trust the PO's own prices (show delta if PO prices differ: "PO says $4.00, contract price is $4.10").
- Error: unreadable scan → "Couldn't read this PDF — paste the lines as text?" fallback textarea.

**Quick order tools (storefront)**
- SKU entry form: paste-a-list support (one per line "SKU, qty"), inline row validation, running total at buyer's prices, add-all-to-cart.
- Variants table on product page: qty inputs per variant, tier-price columns, stock indicators, keyboard navigable.
- All blocks: lazy-loaded, ≤10-point Lighthouse impact budget, graceful without JS (link to standard product page).

---

## 6. Storefront Agent

**Publish flow**
- Pre-publish checklist (all must pass): ≥1 active pricing rule, ≥1 approved buyer, guardrails reviewed, test conversation completed in preview. Publish = theme block enable + confirmation with storefront link.
- Unpublish: instant, one click, no confirm-shaming.

**Chat widget (buyer side)**
- Visibility: approved+logged-in buyers only by default (guest mode opt-in with retail-only answers). Loads lazily; zero impact until opened.
- States: greeting (personalized: name, tier, last order), typing indicator, streaming replies, cart-built card (line items + total + "Review cart" → native cart), quote-request confirmation ("Sent to Mannon — you'll get an email"), error ("I'm having trouble — try again or use the quick order form" + link), offline (widget hides, no broken button).
- Guardrail hits: scripted decline + optional "ask the merchant" escalation which files a message in the admin.
- Hard behaviors: prices only from published rules (test asserts this); checkout always handed to Shopify; conversation ends with cart or clear next step, never dangles.
- RTL: full Arabic UI + agent responds in the buyer's language automatically.

**Guardrails panel (admin)**
- Every toggle takes effect on next conversation (stated). Tone presets + custom instructions box (200 words max, linted for contradictions with hard rules — "you wrote 'offer discounts freely' but discount authority is off").
- Test mode: merchant chats as a simulated buyer (pick any real buyer's context, clearly watermarked "TEST — no orders created").

**Conversation log**
- List with buyer, time, outcome chip (Cart $X / Quote / Answered / Escalated / Declined). Transcript view; "Take over" hands live chat to merchant (agent announces the human). Retention 90d, export CSV. Empty: "No conversations yet — publish the agent to start."

---

## 7. Analytics

- Empty: sample-data preview watermarked "Example — your data appears after your first wholesale order."
- Loading: skeleton chart + tiles. Partial: <7 days → daily bars only, no trend line; annotate gaps ("app installed Aug 12").
- Charts: wholesale vs retail revenue, revenue by group, top buyers/products, rule performance, registration funnel, net-terms aging. Buyer Agent launch date auto-annotated. Export CSV per chart.
- Timezone = store timezone (stated in footer); currency = store currency.
- ✦ Ask-your-data: answers cite the chart they derive from ("from: Revenue by group"); no-data answer offers what *can* be answered; every claim reproducible via a linked filter state.
- ✦ Monthly review: generated 1st of month, kept forever, diff vs previous month; every recommendation has a one-click draft action + "why" expander showing the data behind it.

---

## 8. Settings

- Each section its own card page with save bar; risky toggles (discount combination) carry the explicit warning + link to affected rules count ("affects 3 active rules").
- Email domain verification: DNS records shown copy-able, "Verify" with live status, unverified → falls back to app domain with notice (Massy pattern).
- Translations: table of strings, "✦ Fill missing with AI" per language, human-review flag per string, export/import.
- Tax: tax-exempt criteria, display incl/excl with storefront preview snippet.
- API keys: create/revoke, last-used timestamp, scoped read/write, secret shown once.
- **Agent controls:** permission toggles (screen / draft / auto-approve), brand-voice samples manager, per-type briefing mutes, and the audit log — filterable by actor (agent/staff), action, date; every AI entry links to its artifact (the draft, the conversation, the rule). Retention 12 months.
- Danger zone: pause app (rules stop applying, nothing deleted — the safe "turn it off" every merchant looks for), uninstall data policy stated.

## 9. Plans

- Current plan always visible; usage meters vs plan limits (rules 14/∞, forms 2/∞) with 80% warning banners.
- Upgrade: proration explained before charge; Shopify billing confirm screen; success → unlocked features toast + deep link.
- Downgrade: impact preview listing exactly what pauses (which rules, which features) — nothing silently deleted; export offered first.
- ✦ Plan advisor: recommendation with reasoning from real usage; explicitly allowed to say "stay on your plan" (no dark patterns — Built for Shopify ethics rule).
- Trial: days-left pill, ending email at 3d, expiry → features pause with data intact + one-click resume.
- Billing errors: failed charge → grace banner 7d before pausing; all states designed.

---

## 10–11. Buyer storefront & Demo store (states summary)

- **Login/portal:** wrong-password, not-yet-approved ("Your application is under review — submitted 2d ago"), rejected (neutral copy + contact link), approved-but-not-tagged (self-heals via re-tag job) — all four designed.
- **Account portal:** empty order history ("Your wholesale prices are active — browse the catalog"), net-terms panel empty vs outstanding vs overdue; invoice PDF download per order.
- **Price display:** guest (hidden + "Apply for wholesale" link), pending, approved (tier badge + tier-progress bar), each with loading shimmer that never flashes retail price to wholesale buyers (price flicker = the classic wholesale-app bug — SSR the right price).
- **Demo store:** persona switcher always visible (sticky bar "Viewing as: Customer 2 — Individual variant pricing ▾"), reset-demo-data nightly, agent tour handles "show me tiered pricing" by switching persona + navigating.

---

*Companion docs: `mannon-feature-states-research.md` (why this checklist), `mannon-claude-code-prompt.md` (how to build it).*

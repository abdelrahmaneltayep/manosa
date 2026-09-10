# Research — What Every Mannon Feature Must Ship With
### The feature-completeness checklist, and where it comes from

Before listing states per feature, this doc establishes *the canonical checklist* — grounded in three sources: the **UI Stack** model (every screen is five screens), **Shopify's Built for Shopify requirements** (what app review actually rejects), and **AI-product state patterns** (what agentic features add on top).

---

## 1. The UI Stack — every screen is five screens

Scott Hurff's UI Stack, now standard product-design practice: designers ship the *ideal state* and forget the other four. Every Mannon feature must design all five:

| State | What it means for Mannon |
|---|---|
| **Blank (empty)** | First-run with zero data. Never a dead end — explain the value, show a sample, give one clear CTA ("Create your first pricing rule" + "Let Claude draft one"). |
| **Loading** | Skeleton screens matching final layout (never spinners on full pages — CLS penalty). Optimistic UI where safe. |
| **Partial** | 1–2 items, not enough for patterns. Tables with 2 rows shouldn't show 8 filter controls; charts with 1 month of data shouldn't draw a trend. |
| **Error** | Field-level, inline, red, next to the cause, with the fix. Never auto-dismissing, never a toast for a blocking error. |
| **Ideal** | The populated state everyone designs first. |

## 2. Built for Shopify — what review measures and rejects

From Shopify's official requirements (shopify.dev):

- **Embedded + App Bridge latest**, Polaris look and feel. Rejection triggers explicitly include *buggy/unpolished UI, non-card layouts, mismatched buttons, serif fonts*.
- **Performance budgets, measured at p75 over 28 days:** LCP ≤ 2.5s, CLS ≤ 0.1, INP ≤ 200ms. Storefront extensions must not drop Lighthouse by more than 10 points — this constrains our theme blocks and agent widget (lazy-load, no blocking JS).
- **Onboarding:** a "concise onboarding experience that helps merchants establish the app's core functionality" + home page showing setup status. (Our Claude Setup Wizard must also satisfy the classic checklist pattern.)
- **Errors:** "red, guide merchants to solutions, appear next to relevant fields." No auto-dismiss.
- **Forms:** integrate with the **Contextual Save Bar** (unsaved changes pattern — visible in the Clay video: "Unsaved changes / Discard / Save").
- **Navigation:** App Bridge nav component — our 9 sidebar pages map to it.
- **No dark patterns:** no countdown pressure, no guilt language — relevant to our Plans page and the honest Plan Advisor.
- **Accessibility:** WCAG 2.1 AA contrast minimum; keyboard focus states.
- **Mobile:** no horizontal scroll, nothing hidden on mobile — merchants approve registrations from their phone.

## 3. What AI features add — five extra states

Agentic features have states classic checklists miss. Every Claude-powered feature in Mannon needs:

| AI state | Rule |
|---|---|
| **Thinking / streaming** | Show progress ("Reading your catalog…"), stream drafts token-by-token, always cancellable. |
| **Draft-for-review** | AI output lands as a *draft* visually distinct from saved state (terracotta ✦ accent), with Approve / Edit / Discard. Never auto-applies. |
| **Low confidence / clarify** | When ambiguous ("blue mugs" → 2 SKUs), the AI asks rather than guesses, and shows what it's unsure about. |
| **Unavailable / fallback** | Claude API down or plan doesn't include AI → the manual path still works 100%. AI is an accelerator, never a single point of failure. |
| **Refusal / guardrail hit** | The agent declines out-of-scope asks (discounts it can't grant) with a polite scripted line + escalation to the merchant. Every AI action logged to the audit trail. |

## 4. Cross-cutting checklist (applies to every feature)

Beyond states, each feature ships with:

1. **Plan gating** — locked features show an informative teaser + "Upgrade" (as Clay/Massy do), never a broken page. Downgrade behavior defined (rules pause, don't delete).
2. **Permissions** — staff without approval rights see read-only; actions hidden, not erroring.
3. **i18n + RTL** — every string translatable; Arabic RTL mirrors layout; numbers/currency localized.
4. **Destructive-action safety** — delete/archive requires typed or explicit confirm; undo where possible (30-day soft delete for rules).
5. **Concurrency** — two staff editing the same rule → last-write warning; webhook-driven changes refresh stale lists.
6. **Data limits** — pagination past 50 rows, virtualized tables past 500; CSV imports capped with row-level error reports.
7. **Offline/slow network** — retries with backoff; save operations idempotent.
8. **Notifications & events** — analytics events per key action (rule_created, ai_draft_approved…), email/webhook hooks defined.
9. **Tests** — unit + integration + one happy-path e2e per feature; state screenshots reviewed (empty/loading/error) before merge.

## 5. The template applied in the checklist doc

Every feature in `mannon-feature-checklist.md` is specified as:

> **Feature** → Onboarding hook · Empty · Loading · Ideal · Partial · Errors (validation / network / permission) · Success feedback · Edge cases · AI states (if AI) · Plan gate · RTL note · Tests

Where a generic answer suffices ("skeleton table"), it's stated once per page and inherited; only *feature-specific* details are written out — the tiny details that make the app feel finished.

---

*Sources: Scott Hurff's UI Stack (product-design standard); Shopify, "Built for Shopify requirements" (shopify.dev); Shopify app QA/review checklists (eseospace, digitalheroes); AI-UX draft/approval patterns from Anthropic's Commerce Agents guidance (merchant retains final approval).*

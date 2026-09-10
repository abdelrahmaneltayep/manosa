# Mannon — B2B Wholesale Pricing
## App Sidebar Pages + Features per Page

**Positioning:** Everything Clay / BSS / Massy / WPD / Sami do — but instead of forcing merchants through forms, tables, and 6-step rule builders, Mannon is **AI-first**: you describe what you want, Claude sets it up, and two Claude Commerce Agents (a **Merchant Agent** in the admin, a **Buyer Agent** on the storefront) run the day-to-day.

**North-star UX rule:** every page has two modes — *"Do it for me"* (Claude) and *"Do it myself"* (classic UI). Claude never publishes anything without merchant approval.

---

## Sidebar Navigation (9 pages)

1. Home
2. Pricing
3. Customers
4. Forms
5. Orders
6. Storefront Agent
7. Analytics
8. Settings
9. Plans

*Plus two buyer-facing deliverables outside the admin sidebar: the storefront pages wholesale customers see (§10) and a public agent-guided demo store for the app listing (§11).*

---

## 1. Home (Dashboard)

The command center — replaces Sami's static dashboard with a conversational one.

**Core features (parity)**
- KPI cards: wholesale revenue, wholesale orders, pending approvals, active pricing rules, net-terms outstanding (period selector: 7/30/90 days)
- Setup checklist: enable app embed, create first pricing rule, publish registration form, approve first customer
- App embed status + active app blocks indicator
- Recent activity feed (registrations, orders, rule changes)

**Claude AI features (differentiators)**
- **Claude Setup Wizard (onboarding):** a 2-minute chat — "Tell me about your wholesale business" → Claude drafts your customer groups, a starter pricing rule, and a registration form, shows a preview, and applies everything on one click. Replaces the multi-page setup every competitor has.
- **Merchant Agent briefing:** a daily/weekly digest written by Claude — "3 registrations waiting (2 look legitimate, 1 has a disposable email), Gold-tier revenue up 18%, rule 'Summer Tiers' has had zero uses in 30 days — archive it?"
- **Ask Mannon bar (global, on every page):** natural-language command box — "give VIP customers 20% off the new collection until Friday" → Claude opens a pre-filled draft of the right rule for review.
- **Proactive alerts:** conflicting rules, a discount that drops a product below cost, a spike in one buyer's order volume ("offer them a tier upgrade?").

---

## 2. Pricing

One page for all price logic (merges Clay's "Pricing", Sami's "Wholesale + Volume Pricing", Massy's "Wholesale Pricing", BSS's "B2B Pricing" and WPD's discount groups).

**Core features (parity)**
- Rule types: percentage off, fixed amount off, fixed custom price, tiered/volume quantity breaks, cart-value tiers, B2B discount codes (personalized codes per customer/group)
- Targeting: entire store, collections, products, individual variants
- Audience: customer tags, customer groups, specific customers, guests, B2B companies
- Scheduling: start/end dates, scheduled price changes
- Markets: apply/exclude Shopify Markets, multi-currency price lists
- Priority & stacking rules when multiple rules match (Massy's "set priority" pattern)
- Bulk CSV import/export of prices (wholesale price, quantity-break, and multi-rule templates)
- API sync for ERP price lists
- Draft/active status, duplicate rule, usage counter per rule
- Live storefront preview panel (mobile/desktop) while editing — like Massy's sample-product preview

**Claude AI features (differentiators)**
- **Rule-from-a-sentence:** "Buy 10 get 5%, buy 50 get 12%, only for tagged wholesale customers, exclude sale items" → Claude builds the complete rule with tiers, targeting, and exclusions pre-filled; merchant just reviews and saves.
- **CSV whisperer:** upload *any* messy price sheet (even a supplier's Excel/PDF) — Claude maps columns to SKUs, flags mismatches, and imports. No rigid template required.
- **Margin guard:** Claude checks every rule against product cost and warns "this tier sells SKU-123 below cost" before saving.
- **Tier suggestions:** Claude analyzes past wholesale orders and proposes quantity-break points that match how your buyers actually order.
- **Conflict explainer:** hover any product → "Why this price?" — Claude explains in plain language which rule wins and why.

---

## 3. Customers

Merges Clay's "Customers + Customer groups", Massy's "Tag System", BSS's "B2B Customers".

**Core features (parity)**
- Wholesale customer list: status (pending / approved / rejected), group, tags, lifetime wholesale spend, last order
- Approve / reject with automatic tagging; manual or auto-approval rules
- Customer groups (tiers): Silver/Gold/VIP etc. — each group bundles pricing rules, order limits, payment terms, shipping rules, product visibility
- Auto-tagging engine: assign tags based on spend, order count, location, or form answers (Massy's Tag System)
- Tax-exempt flag + VAT/EU VAT (VIES) validation
- Net-terms eligibility per customer/group
- Internal notes on accounts; import/export customers via CSV
- Shopify B2B companies support (locations, catalogs) on Plus

**Claude AI features (differentiators)**
- **AI application screening:** every registration gets a Claude review — company website checked, email domain vs. company match, duplicate detection, spam scoring → "Recommend approve" / "Needs a look" with reasons. One-click approve from the recommendation.
- **Drafted replies:** approval, rejection, and "we need more info" emails written by Claude in your brand voice (editable before send).
- **Segment builder in plain language:** "show me buyers who spent over $5k last quarter but haven't ordered in 45 days" → instant segment → "move them to VIP" or "have the agent send a win-back note."
- **Tier promotion suggestions:** Claude flags customers whose behavior matches a higher tier and drafts the upgrade.

---

## 4. Forms

Registration form builder (Clay's strongest area, plus BSS multi-step and conditional logic).

**Core features (parity)**
- Multi-form support with templates; draft/active status
- Drag-and-drop builder: pages, fields (text, email, phone, company, address, VAT ID, years in business, file upload for tax ID/license), footer, submit page
- Field validation, required fields, EU VAT validation, spam protection (captcha/honeypot), mandatory privacy-policy checkbox
- Conditional logic (show/hide fields by answers) and multi-step pages (BSS)
- Appearance tab: layout (default/boxed), width, font, colors, mobile/desktop preview
- Email tab: confirmation, approval, rejection notification templates; custom sender domain
- Publish tab: standalone page, link, or theme app block; redirect URL after registration; auto-tag + auto-group on submit; works with New Customer Accounts + legacy login

**Claude AI features (differentiators)**
- **Form-from-a-prompt:** "I sell coffee equipment to cafés in the GCC; I need business license + VAT number and want to reject home users" → Claude generates the full form: fields, validation, conditional logic, approval criteria, and all notification emails — matching your store's brand colors automatically.
- **Approval criteria in plain English:** "auto-approve registered companies with a valid VAT number and 2+ years in business; send the rest to review" → becomes the approval workflow.
- **AI copy & translations:** every label, placeholder, and email localized in one click (Arabic/English RTL-aware out of the box).

---

## 5. Orders

Merges Clay's "Order limits + Payment terms + Shipping rules", Massy's "Order management", Sami's "Quick Order + Add-ons", BSS's "B2B Orders".

**Core features (parity)**
- Wholesale order list: filter by customer/group/tag, wholesale-order auto-tagging
- **Order limits:** min/max order value or quantity per group; quantity increments (case packs); per-product min/max
- **Net payment terms:** Net 15/30/60/90/custom, "pay later" button at checkout, invoice payment, outstanding-balance view, due-date reminders
- **Draft orders:** create manual/draft orders with wholesale pricing applied; buyer-submitted draft orders ("submit for quote") that the merchant approves
- **Quick order tools (storefront):** SKU-entry quick order form, collection quick-buy, variant table on product pages
- **Extra fees:** fixed/percentage fees by quantity, amount, or weight
- **Shipping rules:** wholesale-only rates by order amount/quantity/weight; route B2B orders to a specific inventory location
- Shopify POS support: wholesale prices and rules in-store

**Claude AI features (differentiators)**
- **PO-to-order:** buyer (or merchant) pastes/uploads a purchase order — PDF, spreadsheet, or a plain email ("200 units of the blue one, 50 of each grinder") → Claude matches SKUs, applies the right wholesale prices, and creates the draft order.
- **Quote negotiation assistant:** when a buyer requests a quote, Claude drafts the response with suggested pricing based on that customer's tier, history, and your margin floor — merchant approves before it goes out.
- **Net-terms risk signal:** Claude scores payment reliability per customer (order history + payment punctuality) and suggests raising/lowering terms.
- **Reorder predictions:** "Café Aroma usually reorders every 3 weeks — it's been 4. Have the agent nudge them?"

---

## 6. Storefront Agent  ⭐ (the page no competitor has)

Configure the **Claude Buyer Agent** — a chat concierge on the wholesale storefront, built on the Claude Commerce Agents shopping-agent blueprint.

**Features**
- **Buyer chat concierge (theme app block):** approved wholesale customers can type "reorder my usual, but double the espresso beans" or "build me an opening order for a 20-table restaurant, budget $3,000" → the agent assembles the cart at their prices, respecting their limits, tiers, and visibility rules.
- **Answers buyer questions instantly:** "what's my price for SKU-450 at 100 units?", "where's my last order?", "what are my payment terms?", "am I close to the next discount tier?" — no support ticket needed.
- **Quote requests in chat:** buyer asks for a special price → structured quote request lands in Orders for merchant approval.
- **Tier-aware upsell:** "add 8 more units and you unlock the 12% tier" — proven agentic-commerce lift (Anthropic reports carts up to 35% larger with shopping agents).
- **Guardrails panel (merchant control):** what the agent may do (build carts, quote, answer order status), tone of voice, languages (Arabic/English), off-limits topics, and a hard rule: the agent can never invent a price — it only reads your published rules.
- **Conversation log & takeover:** review every agent conversation; jump in live when needed.
- Classic parity here too: pricing display settings (show/hide original price, "login to see price"), lock wholesale pages to approved tags, wholesale-section theming.

---

## 7. Analytics

**Core features (parity)**
- Wholesale vs. retail revenue, AOV, orders over time
- Revenue by customer group/tag; top wholesale customers and products
- Rule performance: usage and revenue per pricing rule
- Registration funnel: submissions → approvals → first order
- Net-terms aging report; export everything to CSV

**Claude AI features (differentiators)**
- **Ask your data:** "which tier grew fastest this quarter?" "which products do Gold buyers buy that Silver don't?" — answers with charts, in chat.
- **Merchant Agent insights:** monthly written review — what worked, dead rules to archive, suggested price/tier experiments, churn-risk buyers — each with a one-click "draft it" action.

---

## 8. Settings

**Core features (parity)**
- **Display:** show/hide compare-at price, tax incl./excl. display with custom text/colors, hide prices from guests ("login to view")
- **Discount combinations:** allow/deny combining with Shopify discounts; combination priority order (Massy pattern)
- **Notifications:** all email templates (registration, approval, rejection, order, net-terms reminders); custom sender domain + verification
- **Tax & currency:** tax-exempt behavior, VAT display defaults, multi-currency rounding
- **Translations:** every storefront string editable, multi-language
- **PDF templates:** quotes and invoices
- **Integrations & API:** public API keys, webhooks, ERP sync, POS toggle
- **Team & permissions:** who can approve customers / publish rules / configure the agents

**Claude AI features (differentiators)**
- **Agent controls (one place):** approval thresholds for both agents — what Claude may do automatically vs. what always needs a human; full audit log of every AI action.
- **Brand voice profile:** paste 2–3 of your emails → Claude matches your tone in every generated message and translation.

---

## 9. Plans

**Core features (parity)**
- Plan cards (monthly/yearly toggle, yearly discount), current-plan indicator, feature comparison table, 14-day trial, discount-code field
- Suggested ladder (aligned to market: WPD $24.99–64.99, Sami $24.90/49.90, Clay $25–99):
  - **Free** — 1 pricing rule, 1 form, basic limits
  - **Growth (~$29)** — unlimited rules & forms, CSV import, auto-tagging, order limits
  - **Pro (~$59)** — net terms, shipping rules, draft orders, POS, Markets/multi-currency, **Merchant Agent**
  - **Agentic (~$99)** — **Storefront Buyer Agent**, PO-to-order, quote assistant, API/ERP sync, priority support

**Claude AI feature**
- **Plan advisor:** "based on your usage (you created 14 rules and got 32 registrations this month), Growth is enough — you don't need Pro yet." Honest recommendations build trust.

---

## 10. Buyer-Facing Storefront Pages (theme extensions)

Not in the admin sidebar — these are the app blocks/pages wholesale customers see (from the BSS / WPD / Sami demo stores).

**Core features (parity)**
- **Wholesale login / portal page:** dedicated B2B sign-in, "continue as guest" retail view, redirect to the wholesale section after login (BSS pattern)
- **Dedicated wholesale section:** a separate wholesale area/collection, locked by password or customer tag — "login to view prices" for guests (WPD pattern)
- **Buyer account portal:** order history with payment/fulfillment status, addresses, current tier/tags, net-terms balance and due dates (Sami pattern)
- **Product page elements:** quantity-break price table ("Buy 5 → 5%, Buy 20 → 12%"), variant order table, tax incl./excl. dual display, extra-fee notices
- **Cart & checkout elements:** discount summary in cart drawer, MOQ warnings, "pay later" (net terms) button, tax-exempt handling
- **Quick order page:** SKU-entry form, collection quick-buy, bulk add-to-cart

**Claude AI features (differentiators)**
- **Tier progress on every page:** "You're $340 away from Gold pricing" — computed from live rules, not hardcoded
- **Account portal concierge:** the Buyer Agent (page 6) lives inside the portal — "reorder #1003 but double the serums", "when is my Net-30 for order #1002 due?", "download my January invoices as PDF"
- **Smart reorder block:** Claude predicts what this buyer is due to reorder and pre-fills a one-click cart

---

## 11. Demo Store (for the app listing + sales)

Every serious competitor runs a public demo store (BSS, WPD, Sami all do — it's how merchants evaluate before installing). Mannon ships one too, but agent-guided.

**Core features (parity)**
- Public demo storefront with **one-click login personas** (WPD pattern):
  - *Customer 1 — Discounted pricing* (e.g. 35% off storewide)
  - *Customer 2 — Individual variant pricing* (custom price lists)
  - *Customer 3 — Tiered/volume pricing* (quantity breaks)
  - *Guest* — sees the regular retail store for contrast
- Pre-filled sample B2B credentials (no signup friction — Sami/BSS pattern)
- Demo nav mirrors real features: Wholesale, Volume, Register form, Quick order form, Order limits, Net terms, Tax display
- Populated sample order history and net-terms balances in the account portal
- "Book a demo" / "Install app" CTAs

**Claude AI features (differentiators)**
- **Agent-guided tour:** instead of hunting through menus, visitors just ask the demo's Buyer Agent — "show me what a tiered-pricing customer sees" → the agent switches persona and walks them to the right page
- **Live proof of the pitch:** the demo store runs the actual Storefront Agent, so merchants experience chat-to-cart and quote requests before installing — the demo *is* the differentiator

---

## 12. Mannon × Claude Commerce Agents (how the agents power the app)

Anthropic's Commerce Agents blueprint ships two open-source harnesses — a **Shopping Agent** and a **Merchant Agent** — plus a Claude Code plugin that scaffolds them against a real backend. Mannon productizes both.

**The core insight:** competitors treat B2B rules as *configuration*; agents turn them into a *capability*. Once Mannon knows each buyer's prices, tiers, limits, and terms, agents can act on that knowledge — quote, build carts, screen, nudge. The agent is only as good as the pricing engine underneath it, which makes the pricing engine Mannon's moat. Anthropic reports carts up to **35% larger** and shoppers **60% more likely to complete** with shopping agents — and B2B buyers (repeat, high-intent, bulk) are the best-case users.

**Shopping Agent → Mannon's Buyer Agent (§6, §10, §11)**
- Multi-item cart assembly at the buyer's contract prices ("opening order for a 20-table café, budget $3,000")
- B2B constraint handling: MOQs, case-pack increments, order min/max, budget caps
- One-line reorders from order history; order-status / net-terms-due / "my price at 100 units" answers without tickets
- Tier-aware upsell ("add 8 units to unlock the 12% tier")
- Checkout handoff: the agent never touches payment — it hands the cart to normal Shopify checkout / pay-later

**Merchant Agent → Mannon's admin copilot (§1–§5, §7)**
- Daily briefing, "Ask Mannon" command bar, registration screening, rule-from-a-sentence, margin guard, PO-to-order, quote drafting within margin floor, net-terms risk scoring, ask-your-data analytics

**What Shopify's agent stack gives us for free**
- **UCP protocol:** Mannon publishes each buyer's effective prices → any qualified agent (Claude, ChatGPT, Shopify's) quotes the right wholesale price everywhere. Mannon becomes the B2B pricing layer of the agentic ecosystem.
- **Agents read four sources** (product data, Knowledge Base policies, `agents.md`, order history): Mannon auto-generates the wholesale sections of `agents.md` and the policy Knowledge Base from its own settings.
- **Checkout stays Shopify's** — no payment liability.

**Build path:** start from the blueprint's retail demo + Claude Code plugin (~1 week to a working storefront agent), wire lookups to Mannon's rule-engine API so agent answers and storefront display can never disagree, productize `agents.md` as the Guardrails panel, and evaluate on quote-to-order conversion, cart size, and tickets deflected.

**Trust rules baked in:** Claude drafts, the merchant approves; every AI action logged; the agent only reads published rules — it can never invent a price.

---

## Why Mannon wins (summary)

| Competitor pattern | Mannon's answer |
|---|---|
| 6-step rule builders (Massy, Sami) | One sentence → rule drafted by Claude |
| Rigid CSV templates (Clay, WPD) | Any file → AI-mapped import |
| Manual registration review | AI-screened applications with recommendations |
| Static dashboards | Merchant Agent briefings + "Ask Mannon" everywhere |
| No storefront intelligence | Buyer Agent: chat-to-cart, reorders, quotes, tier upsell |
| Support tickets for "what's my price?" | Agent answers from live rules, never invents prices |

**Trust principles baked in:** Claude drafts, the merchant approves; every AI action is logged; the Buyer Agent only reads published prices — it never makes pricing up.

---

*Feature parity mapped from: Clay B2B Wholesale (forms, groups, limits, terms), BSS B2B Solution (multi-step forms, tax display, APIs), Massy (tag system, priority/combinations, markets), Wholesale Pricing Discount (discount groups, net terms, import/export), Sami (volume pricing, quick order, add-ons). Agent capabilities based on Anthropic's Claude Commerce Agents blueprint (Shopping Agent + Merchant Agent, Sept 2026).*

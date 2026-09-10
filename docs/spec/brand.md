# Mannon — Brand Kit

> Portable brand reference for the **Mannon** product family. Paste this into a new
> session when building an app, page, or asset that should look and sound like Mannon.
> Last updated 2026-09.

**What Mannon is:** a B2B wholesale **quoting + reorder** app for Shopify. The story is always
**Quote → counter (with Claude) → accept → native Shopify draft order → reorder.** Mannon rides
Shopify's native B2B (companies, catalogs, payment terms) and prices on draft orders — it never
rebuilds tax, totals, or checkout.

**One-liner:** *B2B quotes and counters with Claude, plus one-tap reorder.*
**Tagline:** *Wholesale quoting, without the email grind.*   **Pill:** *B2B wholesale, done right.*

---

## 1. Logo & wordmark

- **Mark:** a bold indigo **`M`** with a small **lime dot** at its lower-right → reads as `M●`.
- **Wordmark:** **`mannon`**, all lowercase, in ink. Lockup: `M●  mannon`.
- The dot is the one flourish — keep it lime, small, and bottom-right of the M.
- **Do not** use a "Built for Shopify" badge in Mannon's own marketing (removed on purpose).
- Favicon/emoji stand-in when needed: a simple `M` tile on indigo.

```html
<span class="mannon-logo">
  <span class="mark">M<i class="dot"></i></span><span class="word">mannon</span>
</span>
<style>
.mannon-logo{display:inline-flex;align-items:center;gap:.6rem;font-weight:800;
  font-size:1.9rem;letter-spacing:-.02em;color:var(--ink)}
.mannon-logo .mark{position:relative;color:var(--indigo);font-weight:900;font-size:2.1rem;line-height:1}
.mannon-logo .mark .dot{position:absolute;right:-.5rem;bottom:.15rem;width:.5rem;height:.5rem;
  border-radius:50%;background:var(--lime)}
</style>
```

---

## 2. Color

Indigo is the primary; **lime is an accent only** (the dot, a card's top-border, a success/CTA) —
never a large fill. Neutrals are cool, biased very slightly toward indigo.

| Token | Hex | Use |
|---|---|---|
| `--indigo` | `#4f46e5` | primary: buttons, links, active nav, accent headline phrase |
| `--indigo-deep` | `#3d33c7` | hover / pressed indigo |
| `--indigo-soft` | `#eef0ff` | chips, icon tiles, soft backgrounds |
| `--lime` | `#84cc16` | the logo dot, feature-card top border, buyer "Accept" CTA, success |
| `--lime-soft` | `#eef6df` | success background |
| `--ink` | `#1c1d2b` | primary text |
| `--sub` | `#6b7280` | secondary text (cool grey) |
| `--line` | `#eceded` | borders / dividers |
| `--purple` | `#5b4bf0` | **buyer portal** header only (distinct from admin indigo) |

**Signature background:** soft diagonal wash `linear-gradient(135deg,#eef0ff 0%,#f6f4ff 55%,#eefbe9 100%)`
with two low-alpha "blobs" (indigo `rgba(124,110,240,.10)` top-right, lime `rgba(132,204,22,.12)` bottom-left).
For multi-screen sets, tint each screen differently but keep it pale: lavender `#f4f5fc`, pink `#fff1f6`,
green `#f4faea`, amber `#fff6ec`, violet `#f2efff`.

**Semantic status chips** (text on tint):
| State | Text | Bg |
|---|---|---|
| Submitted / Sent | `#2f6bd6` | `#eaf1ff` |
| Countered | `#b7791f` | `#fff2dd` |
| Accepted / Ordered | `#1f8a53` | `#e7f7ee` |
| Expiring / Error | `#d64545` | `#fdeaea` |

```css
:root{
  --indigo:#4f46e5; --indigo-deep:#3d33c7; --indigo-soft:#eef0ff;
  --lime:#84cc16; --lime-soft:#eef6df;
  --ink:#1c1d2b; --sub:#6b7280; --line:#eceded; --purple:#5b4bf0;
  --radius:12px; --radius-lg:16px;
  --shadow:0 16px 40px rgba(28,29,43,.08);
  --shadow-sm:0 4px 14px rgba(28,29,43,.06);
}
```

---

## 3. Typography

- **App & marketing UI:** the system stack — `-apple-system, BlinkMacSystemFont, "Segoe UI",
  Roboto, Inter, "Helvetica Neue", Arial, sans-serif`. Fast, native-feeling, no web-font load.
- **Embedded Shopify admin:** use **Polaris** defaults — don't override Shopify's type there.
- **Headlines:** weight **800**, tight tracking (`-0.02` to `-0.03em`), `text-wrap:balance`.
  Signature move: **two-tone headline** — ink for the first half, `--indigo` for the key phrase.
  e.g. "Wholesale quoting, **without the email grind**".
- **Body:** `--sub` grey, 1.5 line-height, ~40–60rem measure.
- **Editorial/brand documents** (not the app): pair **Sora** (display) + **Newsreader** (serif, for
  quoted/spoken text) + **IBM Plex Mono** (labels, timecodes, data). Only for docs/artifacts.

---

## 4. Voice & tone

Grade every line against Shopify's experience values: **Considerate · Empowering · Crafted ·
Efficient · Trustworthy · Familiar.**

- Plain language, **benefit-first**, honest about what the app does and doesn't do.
- Active voice; a control says exactly what happens ("Send quote", then "Quote sent").
- **No** generic marketing language, **no** keyword stuffing, **no** jargon.
- Errors explain what went wrong and how to fix it — no apologies, no vagueness.
- Product vocabulary (use consistently): *quote, counter, accept, reorder, draft order, net terms,
  buyer portal, magic link (passwordless), AI Order Pad, Draft with Claude, Claude insights.*

---

## 5. The Claude principle (brand signature)

Mannon's AI is **human-in-the-loop, always**. This is both an engineering guardrail and a brand
promise — surface it, don't hide it.

- **Dual-mode:** every AI surface offers **Manual** + **`✦ Draft with Claude`**. Claude only
  **pre-fills**; it never sends, prices, or writes anything on its own.
- **`✦`** (sparkle) is the glyph that marks every Claude feature. Prefer "**Draft with Claude**"
  over a generic "AI".
- Every AI output lands on a **confirm screen**. Temperature 0. Every AI-returned id/SKU is
  validated against the live catalog before use.
- **Signature trust line** (use verbatim or close):
  > ✦ Drafted by Claude · review before sending. **You send it, not the AI.**
  Short form: **"Claude drafts, you send. It never acts on its own."**
- This mirrors Anthropic's *Claude Commerce Agents* "human approval gate" + "no order placed by the
  model" patterns — good alignment to cite for trust/review.

---

## 6. UI components & patterns

- **Buttons:** primary = `--indigo` bg, white, weight 800, `--radius` corners, `--shadow-sm`,
  `--indigo-deep` on hover, visible `focus-visible` ring `0 0 0 3px rgba(79,70,229,.4)`.
  Buyer-side **Accept** CTA = `--lime` bg with `--ink` text. Ghost = white + `--line` border.
- **Feature card:** white, `--radius-lg`, `--shadow`; a **4px lime top-border** inset from the
  edges; a 3rem pale-indigo (`--indigo-soft`) rounded icon tile holding a **line icon stroked
  `--indigo`**; bold 2-line label + `--sub` description.
- **Pills / badges:** `border-radius:999px`, `--indigo-soft` bg / `--indigo` text; status pills use
  the semantic table above.
- **Device mockups** (for screenshots/screencasts): browser chrome with 3 dots + a breadcrumb URL
  `admin.shopify.com › apps › mannon › …`; phone frame for the buyer portal; purple `portal.mannon.app`
  header for buyer views.
- **Surfaces:** in the embedded admin, **Polaris only** — no custom UI where Polaris has a pattern.
  Express the brand on **non-Polaris surfaces**: the landing page and the buyer portal.

```html
<!-- feature card -->
<div class="fcard">
  <span class="ic"><!-- inline SVG line icon, stroke var(--indigo) --></span>
  <strong>Draft with Claude</strong>
  <span class="sub">Claude drafts counters &amp; carts — you review and send.</span>
</div>
<style>
.fcard{position:relative;background:#fff;border-radius:var(--radius-lg);padding:1.9rem 1.5rem 1.6rem;
  box-shadow:var(--shadow)}
.fcard::before{content:"";position:absolute;top:0;left:1rem;right:1rem;height:4px;
  border-radius:0 0 4px 4px;background:var(--lime)}
.fcard .ic{display:flex;align-items:center;justify-content:center;width:3rem;height:3rem;
  border-radius:.85rem;background:var(--indigo-soft);margin-bottom:1rem}
.fcard .ic svg{width:1.5rem;height:1.5rem;fill:none;stroke:var(--indigo);stroke-width:2}
.fcard strong{display:block;font-size:1.2rem;font-weight:800;letter-spacing:-.01em}
.fcard .sub{display:block;margin-top:.5rem;color:var(--sub);line-height:1.5}
</style>
```

---

## 7. Product facts (keep copy consistent)

- **Plans (flat monthly, no per-order fees ever; annual = 2 months free; 14-day trial):**
  **Free $0 · Starter $9 · Growth $29 · Scale $69.** Claude features unlock at **Growth+**.
- **Built on native:** Shopify owns money, tax, terms, checkout. Accept → a real Shopify **draft order**.
- **Never** stores card data. **Passwordless** buyer portal via hashed magic links. **HMAC-verified**
  webhooks. Minimum OAuth scopes.

---

## 8. Do / Don't

**Do**
- Lead with the benefit and the quote→counter→reorder story.
- Two-tone headlines; indigo primary; lime as a small accent.
- Mark Claude features with `✦` and keep the "you send it" trust line.
- Polaris inside the admin; custom brand outside it.

**Don't**
- Use lime as a large fill, or as the primary. It's an accent.
- Add a "Built for Shopify" badge to Mannon's own marketing.
- Let AI act autonomously, or imply it does.
- Keyword-stuff or use generic marketing language.
- Recompute money/tax — always defer to Shopify's draft order.

---

### Quick-start for a new app in the Mannon family
1. Drop the `:root` tokens (§2) and the logo lockup (§1) in.
2. System font stack; two-tone 800-weight headlines (§3).
3. Indigo primary buttons, lime accents, feature cards with the lime top-border (§6).
4. If it uses AI: dual-mode `✦ Draft with Claude`, confirm screen, the trust line (§5).
5. Write copy against Shopify's six experience values (§4).

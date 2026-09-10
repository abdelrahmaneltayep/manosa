# QA report — 3.4 · Quick order storefront blocks

Reviewed as someone who did not write it and does not trust it.

### 1. Test plan

The spec: checklist §5's "Quick order tools (storefront)" — a SKU entry form with
paste-a-list support, inline row validation, a running total at the buyer's
prices and add-all-to-cart; a variants table on the product page with quantity
inputs, tier prices, stock indicators and a keyboard path; and for both blocks
lazy loading, a ≤10-point Lighthouse budget, and graceful degradation without
JavaScript.

Happy paths: a buyer pastes a column out of a spreadsheet and gets their
wholesale prices and a cart; a buyer on a product page types quantities across
three sizes and adds them all.

Invented abuse cases:

1. **Malformed input.** A paste with headers, blanks, a "TOTAL" line, quantities
   before the SKU, "a dozen" where a number belongs, a duplicate SKU, 200,000 of
   something, and a pasted file. A proxy payload that is not JSON.
2. **A forged request.** The one that matters: asking for another buyer's
   contract prices by editing `logged_in_customer_id`. Also a missing signature,
   an added parameter, a removed one, and a secret that is not set.
3. **Wrong tenant.** A signed request for one shop reaching another's rules or
   another's buyer.

### 2. Automated tests

`npm test` — **1,166 tests, 61 files, all passing** (1,084 at 3.3). New:

- `tests/unit/paste-list.test.ts` (17) — every separator, headers skipped,
  quantity-first lines, thousands separators, duplicates added together and
  reported, the line cap, and a full messy purchase order.
- `tests/unit/proxy-signature.test.ts` (16) — the signable payload's exact
  shape, and every way a request can be forged: no signature, a tampered
  parameter, an added one, a removed one, the wrong secret, a short signature,
  and no secret at all.
- `tests/unit/storefront-blocks.test.ts` (29) — the block audit: no external
  script, no stylesheet, no library, inside a byte budget, no `innerHTML`, no
  guessed paths, the no-JS path present in both, the source attribute in both,
  and every translation key a block asks for actually existing.
- `tests/integration/storefront.test.ts` (20) — `withProxy` opening the scope,
  refusing an uninstalled or paused shop, and 401ing before it looks up any
  shop; pricing from the buyer's rules; a three-decimal currency; unknown and
  unpublished SKUs; one query for the whole paste; the four stock states; and
  two tenant-boundary cases.

`npx playwright test` — **230 passing** (214 at 3.3), including
`tests/e2e/storefront-blocks.spec.ts` (16), which drives **the blocks' own
scripts in a real Chromium** against a stubbed proxy.

Lint, `tsc --noEmit`, `npm run build` and `prettier --check` are clean.

### 3. State walkthrough

12 states captured to `qa/3.4/`. Quick order: empty, priced with the rule behind
each price and a running total, unknown SKUs and duplicate lines, plan-gated, a
failed lookup, on a phone, and with JavaScript off. Variants table: priced,
plan-gated, add-all, on a phone, and with JavaScript off.

These are a different kind of capture from every other task's. The admin screens
are structure-only renders; **these are the shipped JavaScript running in a real
browser**, so what they prove is stronger — the states render, the requests go
where they should, and the no-JS paths are real. What they do not prove is that
Shopify's Liquid produces the same markup, because a stand-in renders it here.
Every capture says so at the top.

Two things came out of looking:

- The quick-order results table had **no header row** — six anonymous columns of
  numbers, and nothing at all to a screen reader. It now has proper column
  headers and the SKU is its row's heading.
- The results table **overflowed the page on a phone**, which the mobile test
  caught. Both tables now scroll inside their own box.

### 4. Cross-tenant check

The proxy is the new attack surface, so it got the most attention.

`withProxy` verifies the signature **before it looks up any shop at all** — a
test asserts the 401 arrives without a database read. It then opens the tenant
scope from the *signed* shop, so every query inside is scoped by construction
rather than by discipline.

Two cases prove it end to end: the same buyer id, signed for two different
shops, is priced by each shop's own rules ($6.50 in one, $9.00 in the other);
and a shop that does not know a customer prices them as a guest rather than at
another shop's tier. An uninstalled shop 404s; a paused one 503s.

### 5. The invariants

| Rule                                           | Status at 3.4                                                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every price comes from the pricing engine      | Held, and this was the hardest place to hold it. Liquid computes nothing; both blocks ask the app, which asks `resolvePrice`. The block audit test forbids a price being composed in a block. |
| Every query is shop-scoped                     | Held, from the signed shop, in one place.                                                                                                                                              |
| AI drafts, a person approves                   | Held; nothing here is AI.                                                                                                                                                              |
| Nothing claims to have happened that did not   | A SKU that was not found is shown, never dropped. A duplicate line says the quantities were added. A gated store gets a plain sentence, and the variants table simply keeps the theme's prices. |
| Deciding shows its working                     | Each priced line names the rule that produced it, on the storefront as in the admin.                                                                                                   |
| No unhandled promise rejections in the e2e run | Clean.                                                                                                                                                                                 |

No secret reaches the client: the blocks carry no key, and the proxy secret is
read only on the server.

### 6. Bugs found and fixed

1. **The variants table would have posted `quantity=0` lines.** One form for the
   whole table posts every row, including the ones a buyer left alone, and
   Shopify's `/cart/add` refuses a line of zero — so the no-JS path this block
   exists to protect would have failed on every submit. Restructured to one form
   per row, which also means each row works on its own. Found by thinking about
   what the form would actually send, before any test.

2. **The results table overflowed the page on a phone.** Six columns at 390px.
   Caught by a mobile test; both tables now scroll inside their own box rather
   than pushing the page sideways.

3. **The results table had no header row.** Found by looking at the capture.
   Six columns of numbers with nothing naming them, and nothing at all for a
   screen reader.

4. **`data-mannon-list` was read but never written.** The variants script asked
   each row for a list price the markup did not carry, so every variant would
   have been priced from zero. Fixing it also removed a decimal round-trip:
   Liquid's price is already in minor units, so it goes across as-is and a
   three-decimal currency survives.

5. **A hardcoded `× 100` in the SKU pricing path**, the same shape as the bug
   3.2 shipped. Replaced with the engine's `parseMoney`, and covered by a KWD
   test that would have failed by a factor of ten.

6. **`window.Shopify.routes.root` was used without checking it exists.** On a
   storefront where it is absent the block would have thrown and left a buyer
   with a dead form; it now stays in its no-JS state instead.

One more was a test rather than the code: the paste parser correctly turns a
trailing "TOTAL 170" line into an order line, which becomes "no such SKU" at
lookup. My assertion expected it to be skipped. Guessing that a line is a
summary — and being wrong about a product genuinely called TOTAL — is the worse
failure, so the code was right and the test was wrong.

### 7. Open items

- **No Lighthouse run.** It needs a real storefront. What is enforced instead is
  everything that would spend the budget: no external script, no stylesheet, no
  library, under 16KB inline, nothing fetched before the table is near the
  viewport. **The 10-point claim is unverified** and should be the first thing
  checked on a dev store.
- **Shopify's Liquid has never rendered these blocks.** The stand-in in
  `tests/support/liquid-stand-in.ts` is enough to get the script into a browser;
  it is not a Liquid implementation. A filter or a whitespace rule it gets wrong
  would show up only on a real theme.
- **The App Proxy has never been exercised.** The signature scheme is
  implemented from Shopify's documented algorithm and tested both ways, but no
  request has ever arrived from Shopify. The `[app_proxy]` URL in
  `shopify.app.toml` points at localhost and needs the real app URL at deploy.
- **`productVariants(query:)` with `sku:"…" OR sku:"…"`** is asserted against a
  fake. Whether that syntax returns what a merchant expects, and how it behaves
  past 100 terms, needs a store with a catalogue.
- **Keyboard navigation is only as good as the markup.** Every control is a real
  input or button with a label, so tab order follows the table — but nobody has
  driven it with a keyboard or a screen reader.
- **No collection quick-buy block.** The spec's §10 mentions one; the checklist
  block that governs 3.4 does not, and it was left rather than half-built.
- **A guest sees list prices** rather than being refused, which is deliberate —
  they have no tier to apply.

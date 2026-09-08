# @mannon/pricing-engine

Resolves `{ customer, product, quantity, market } → price`.

**Every price Mannon shows or charges comes from here.** The Shopify discount
Function, the storefront blocks, the Buyer Agent's tools, the PO parser and the
admin previews all call this module. Nothing computes a price on its own —
that is the rule the whole product rests on, because the Buyer Agent is only
trustworthy if its answer and the checkout total are the same number.

## Constraints this package holds itself to

- **Pure.** No I/O, no database, no Node built-ins, no dependencies. It runs
  unchanged in the admin, in a Shopify Function, and in a browser.
- **Deterministic.** Same input, same output, always — including the order rules
  arrive in. Golden vectors depend on it and so does debugging a merchant's
  "why is this price different" report.
- **Exact.** Money is integer minor units. No floating-point arithmetic touches
  a price.
- **Explains itself.** Every resolution returns a trace saying which rules were
  considered, which applied, and why the others did not. "Why this price?" in
  the admin and the agent's answer to a buyer both read that trace rather than
  guessing.

## Testing

- `test/golden/vectors.json` — human-reviewable cases taken from the product
  spec's own examples. They were written before the implementation, and a
  change in behaviour has to be argued for by editing a vector.
- `test/properties.test.ts` — invariants over generated input.

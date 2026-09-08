# packages/

Workspace packages shared across the app and its extensions.

- `pricing-engine/` — the one deterministic module that resolves
  `{ customer, product, quantity, market } → price`. Every surface that shows a
  price reads from it: the Shopify discount Function, storefront blocks, the
  Buyer Agent's tools, the PO parser, and admin previews. Pure and
  dependency-free so the same code runs in all of them.

# packages/

Workspace packages shared across the app and its extensions.

- `pricing-engine/` — phase 1.1. The one deterministic module that resolves
  `{customer, product, qty, market} → price`. Every surface that shows a price
  reads from it: the Shopify discount Function, storefront blocks, the Buyer
  Agent's tools, the PO parser, and admin previews.

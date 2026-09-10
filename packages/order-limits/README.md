# @mannon/order-limits

What a wholesale cart has to satisfy before a buyer can check out: a minimum or
maximum order value, a minimum or maximum quantity, and case-pack increments.

Pure and deterministic, in the same spirit as `@mannon/pricing-engine`. Three
places need the same answer — the admin's preview, the cart validation Function
at checkout, and the storefront message — and a limit that reads one way in the
admin and blocks differently at checkout is worse than no limit at all.

It reports **violations with their numbers**, not sentences. "Add $38 to reach
your $200 minimum" is a message the merchant wrote and this module filled in;
the module itself is not in the business of copy, and the same violation is
rendered in Arabic elsewhere without changing anything here.

The only import is `@mannon/pricing-engine`'s money helpers, so money stays
integer minor units everywhere and is never converted between currencies.

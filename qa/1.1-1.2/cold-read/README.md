# Cold-read probes for 1.1 / 1.2

Every file here is a **failing** test that demonstrates a finding in
`../COLD-READ.md`. They live outside `tests/` on purpose, so the committed
suite stays green.

```bash
export TEST_DATABASE_URL='postgresql://mannon:mannon@localhost:5432/mannon_cr1?schema=public'
npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
```

Expected at the time of writing: **14 failed, 4 passed**.

| File                          | Finding                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `storefront-vs-checkout.test.ts` | P0-1, P0-2 — collection membership at checkout and on the storefront |
| `function-money.test.ts`      | P0-3 — zero-decimal currencies, and one bad line killing the cart |
| `rounding.test.ts`            | P1-5 — two-decimal percentages vs exact half-up (~23s)          |
| `rounding-integer-pct.test.ts`| P1-5 — whole-number percentages, e.g. $10.75 at 6% (~22s)       |
| `why-this-price.test.ts`      | P1-6 — the explain panel is not the checkout answer             |
| `schedule.test.ts`            | P1-7, P2-17 — day boundaries, shop timezone, unreadable dates   |
| `cascade.test.ts`             | P1-8, P1-9 — a contract price overwritten, and a price uplift   |
| `abuse.test.ts`               | P1-14 (fails: a format bump is silent) and a negative percentage (passes) |
| `tenancy.test.ts`             | Invariant 2 — **passes**; kept as the evidence                  |

The two passing assertions are deliberate: they are the abuse cases that the
code already handles correctly, and a re-run should keep them passing.

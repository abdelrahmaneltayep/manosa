# Golden vectors

Each case in `vectors.json` is a full input and the exact price the engine must
return. They were written from the product spec's examples **before** the
resolver existed, so they describe intended behaviour rather than recording
whatever the code happened to do.

Changing an expectation here is changing what a merchant is charged. It needs a
reason in the pull request, not a re-record.

## Shape

```jsonc
{
  "rules": { "<id>": {/* a PricingRule, money as decimal strings */} },
  "cases": [
    {
      "name": "unique-case-name",
      "spec": "where in the product spec this comes from",
      "why": "what this case is protecting",
      "rules": ["rule-id", "..."],
      "context": {/* customer, product, quantity, market, now */},
      "expect": {
        "finalPrice": "9.50",
        "appliedRules": ["rule-id"],
        "skipped": { "other-rule": "reason-code" },
        "nextTier": { "quantity": 20, "unitPrice": "8.80" },
      },
    },
  ],
}
```

Money is written as a decimal string in the case's currency so the file stays
readable. The harness converts to minor units.

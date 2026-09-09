# ADR 0009 — CSV import and export

**Status:** accepted (phase 1.4)

## Two templates, not one

A single sheet flexible enough for every rule type would carry twenty columns
and be worse than either of the two we ship: `rules` (one row per rule) and
`quantity_breaks` (rows sharing a name become one rule with several breaks,
which is how a merchant already thinks about "buy 5 get 5%, buy 20 get 12%").

Export writes the same shapes import reads, so a merchant can export, edit in a
spreadsheet, and import the result. A format that only goes one way is a dead
end at the moment someone needs to make fifty edits.

The downloaded template's example rows import cleanly. An example that
references a SKU only we have would greet a merchant's first attempt with an
error; how to target SKUs is explained by the column instead.

## Our own CSV reader

Merchant spreadsheets are the messiest input this app takes: quoted fields with
embedded commas and newlines, CRLF, a byte-order mark from Excel, ragged rows,
blank trailing lines, a stray `"` in `12" pipe`. Owning the parser makes those
cases ours to test rather than ours to hope about, and it is about a hundred
lines against seventeen tests.

## Nothing is imported before the merchant has read what it would do

Upload produces a **plan**, never a write: how many rules would be created,
which rows are wrong and why, and what is merely worth checking. The merchant
accepts or picks a different file.

- **Unknown SKUs are listed, not skipped.** A dropped SKU is a price that
  quietly does not apply, and the merchant finds out from a buyer.
- **A value of zero is a warning.** Free samples and placeholders are real; a
  zero is not automatically a mistake.
- **A repeated quantity takes the later row**, and says so — that is usually
  what a spreadsheet edit means, but not something to decide silently.
- **A duplicate name is a warning, not a block.** Checklist §2 allows
  duplicates; the merchant is told, and both are created.
- **One bad row costs that row.** The good ones still import.

The problem list downloads as a CSV with line numbers and reasons, so a
two-hundred-row file with six problems is six lines to fix rather than a hunt.

## The size check happens before the import, not after

Publishing to checkout fails on the _whole_ ruleset if it exceeds Shopify's
metafield limit. Without a pre-check a merchant would import two hundred rules,
see success, and only later find checkout still on the old prices.

So the dry run estimates the published size including what is already active,
and refuses the import with the numbers rather than letting it half-land. Only
active rules count; drafts never reach checkout.

This is also the clearest sign of a real limit: per-variant price lists of any
size do not fit in a metafield ruleset. Solving that properly needs a
`price_list` rule kind holding many variant→price entries in one rule, which is
an engine change and belongs in its own task.

## The held upload

A browser will not resubmit a file input, so the confirm step cannot ask for the
file again — it has to import exactly the bytes that were checked. The upload is
held in `RuleImportDraft` between review and confirm and deleted the moment it
is used.

## Undo

An import records the ids it created and can be undone in one click for an hour.
Undo deletes **exactly those rules and nothing else**: an import only ever
creates — a name collision is reported and imported alongside rather than
overwriting — so there is nothing to restore and no way to lose a rule the
merchant wrote by hand.

After the hour the shortcut goes away, not the data: the copy says so and points
at archiving from the rules list.

## Deferred

`.xlsx` is not accepted. The checklist puts it in the dropzone, but "upload any
messy price sheet, even a supplier's Excel" is the CSV whisperer (phase 4.3),
where AI column mapping makes an arbitrary sheet meaningful. Accepting `.xlsx`
here and then erroring would be worse than saying CSV.

# Migrations

`migrate deploy` applies these in name order and checks each file against the
checksum recorded in `_prisma_migrations`. **An applied migration is not
editable** — not even to add a comment — because a changed file fails the
deploy on every environment that already ran it. Anything a future reader needs
to know about one of them belongs here instead.

## `aiMayAutoApprove` never existed

`20260911123138_agent_controls` adds `Shop.aiMayAutoApprove`;
`20260911123310_agent_controls_two`, written the same afternoon, drops it. Both
are in one commit, so no deployment ever ran the first without the second, and
no shop has ever had the column.

It is in the history because the agent-controls work started with three
permissions and shipped with two: auto-approval would be an AI write path that
changes customers with no person in it, which invariant 3 does not allow. The
column was removed rather than left switched off, because a column nothing can
set is the shape a later caller trusts (the same reason `MonthFacts.topGroup`
was dropped).

If you are here because you found `aiMayAutoApprove` in a `git log` and went
looking for the feature: there is no feature. Approval is a person's, by
design. See `docs/adr/0027` and invariant 3 in `CLAUDE.md`.

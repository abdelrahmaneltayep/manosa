# 27. One gate for what Claude may do

Date: 2026-09-11 · Status: accepted

## Context

Checklist §8 asks Settings for **"permission toggles (screen / draft /
auto-approve)"**. There were none. Every ✦ surface in the app gated on
`isAiAvailable()` — is an `ANTHROPIC_API_KEY` set — and that was the whole
answer to every question a merchant might have about Claude's authority.
`aiScreening: isAiAvailable()` in `app.customers.applications.tsx` was the
entirety of _"may Claude read my trade applicants"_.

Three problems with that, in increasing order of seriousness. A merchant who
wanted drafted emails but no opinion on their applicants had no way to say so.
The only thing standing between Claude and a merchant's applications was an
environment variable they cannot see, change, or know about. And when a ✦
surface was off, the screen could only say "no key" — never "you switched this
off", which is the reason they can act on.

## Decision

**One function, `aiGate(permission)`, answers all three questions** — the
merchant's permission, the plan, and the key — and returns which of them is in
the way.

It is a single choke point for the same reason `activeEngineRules` is the only
read behind pricing: a gate with fifteen call sites is a gate with fifteen
chances to forget one, and every one of those fifteen had already forgotten
two of the three questions. All fifteen now call `aiGate`.

Permission is checked **first**, because it is the only one of the three a
merchant can change on the page they are looking at.

Two permissions ship, not three:

- `aiMayScreen` — reading a registration application and saying what it looks
  like. Defaults **on**: it is advisory, it has never approved anybody, and it
  is the ✦ feature the checklist leads with.
- `aiMayDraft` — writing a message, a rule, a briefing or a review for a person
  to approve. Defaults **on**, for the same reason.

## Auto-approve is deliberately absent

§8 names a third toggle. Nothing in this app approves an application without a
person — there is no auto-approval path at all — so a switch for it would be a
control for behaviour the product does not have.

6.4 shipped exactly that (`taxExemptNeedsApproval`, gating a tax-exemption
flow that does not exist) and the cold read caught it. The toggle arrives with
auto-approval itself, defaulting **off**, because Invariant 3 is that AI drafts
and a person approves, and a default that lets Claude approve a trade account
unattended is the one default this app must not ship.

## Alternatives rejected

**A single "AI on/off" switch.** Simpler, and useless: the merchant most
likely to want a control is the one who wants _some_ of it, and an all-or-
nothing switch means they turn everything off.

**Per-feature toggles** (one for screening, one for briefings, one for the
monthly review, one for rule-from-a-sentence…). Ten switches for two
decisions. "May it read my applicants" and "may it write me a draft" are the
two questions a merchant actually has.

**Checking permission at the prompt layer** rather than at each surface.
Cheaper to write and wrong for the merchant: a page that renders the ✦ button,
takes the click, and only then discovers it is not allowed has already lied
about what it offers.

## Consequences

- `aiGate` reads the `Shop` row per call. It is a primary-key lookup on a row
  most of these paths already load, and it is cached by Prisma within a
  request in practice.
- `AiGate.blockedBy` gives every ✦ surface a reason to show rather than a
  blank. Surfaces still have to render it; 6.5 wires the reason into Settings
  and leaves the per-page copy to 6.6.
- A merchant switching screening off does not un-screen the applications
  already screened. Those verdicts were true when they were made and the log
  says who made them.

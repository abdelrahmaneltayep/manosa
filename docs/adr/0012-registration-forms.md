# 12. One form renderer, and a form that works without JavaScript

Status: accepted (phase 2.2)

## Context

The registration form is the only screen in Mannon a member of the public
ever sees. It has to render inside a merchant's theme, on a phone, in Arabic,
and — often enough to matter — before or without any script running. It also
has to reject what should be rejected without turning away a real buyer.

## The form definition is a pure module

`app/lib/forms/schema.ts` decides what a form is and whether a submission is
valid. Three places need that answer: the builder's preview, the standalone
page, and the endpoint a submission arrives at. A form that validates one way
in the admin and another way for a buyer produces applications that silently
never arrive, and nobody finds out.

Two rules fall out of it:

- **Conditional visibility is resolved from the answers, not from the page.**
  Without JavaScript every field is rendered, including the licence upload that
  only applies to distributors. The server works out which fields the answers
  make visible and requires only those. That is what makes the no-JS path
  _work_ rather than merely render.
- **A form that cannot work cannot go live.** No email field, a condition loop,
  a merge tag that will never fill in — all refused at publish. A draft may be
  unfinished; a published form may not.

## There is one renderer, and the theme block frames it

A theme app extension could re-implement the form in Liquid. It would be a
second implementation of the code that decides whether an application is
accepted, and the two would drift the first time a field type was added.

The alternative — publishing the definition to a metafield and looping over it
in Liquid — depends on how app-reserved metafields are exposed to theme app
extensions, which cannot be verified from here: `shopify.dev` is unreachable
and there is no store to probe. Guessing at it and being wrong means a block
that renders nothing on a merchant's live storefront.

So the block frames the app's own page. One renderer, version-pinned, no
Liquid copy of the validation rules, and it works with scripts off. The costs
are real and recorded in QA-REPORT 2.2: the form does not inherit the theme's
typography (which is what the Appearance tab is for), and the frame needs a
height, which a small script trims to the content and which falls back to a
scrollable frame without it.

`frame-ancestors` names the merchant's own storefront and nothing else, which
is why publishing a form reads the shop's primary domain. The admin's CSP,
which allows only Shopify, is deliberately not applied to these pages.

## VIES: unverified is not invalid

VIES is unreliable in a specific way — individual member states go offline for
hours. Two outcomes stop an application: nothing, and "VIES answered, and said
no". Everything else is `unverified`, accepted with a flag on the reviewer's
desk: a timeout, a 500, a member-state error inside a 200, a country VIES does
not cover, a format we do not recognise.

Gulf VAT numbers are never sent to VIES at all. A Saudi TRN is a real
registration that VIES would answer "no" about, and that answer would turn a
valid applicant into a rejected one.

## Spam protection without a captcha

A honeypot, a minimum fill time, and a rate limit per address. A captcha taxes
every real applicant to stop the bots a honeypot already stops, and the ones it
does not stop are solving captchas anyway.

Nothing is deleted. A caught submission is stored with the reason that caught
it, because a real buyer wrongly marked spam is a lost customer that someone
has to be able to find. A honeypot or a three-second fill is answered as
success — telling a bot which signal caught it is free tuning for its next
run — but a rate-limited visitor is told, because they are probably a person
who pressed submit twice.

## What this deliberately does not do

- **Nothing scans uploaded files.** Virus scanning needs a service; there is
  none. The upload is stored with `scannedAt` null and the admin says "not
  virus-scanned" rather than implying it is clean, and downloads are served
  `nosniff`, sandboxed, and as attachments.
- **No email is sent.** `app/lib/email/send.server.ts` is a seam with no
  transport. The test-send button says nothing was sent rather than reporting a
  success that never happened — a merchant would otherwise find out from an
  applicant who never got a confirmation.
- **Multi-step pages are not built.** They are in the parity list, not in the
  checklist's states, and a second page is a second place for conditional
  visibility to be resolved.

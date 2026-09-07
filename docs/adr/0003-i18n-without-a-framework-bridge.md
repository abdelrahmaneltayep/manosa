# ADR 0003 — i18n on i18next directly, no framework bridge

**Status:** accepted (phase 0.2)

## Context

Every string ships in English and Arabic from day one, with RTL mirroring. That
rules out a lookup table: Arabic has six plural forms, so plural selection has
to come from `Intl.PluralRules`, which is what i18next already does.

The usual Remix integration is `remix-i18next`. Its current major peers on
`react-router@8`; the release that supports Remix 2 (`remix-i18next@6`) pins
`i18next@23`, two majors behind.

## Decision

`i18next` + `react-i18next` directly, with about sixty lines of integration in
`app/i18n.server.ts`, `app/i18n/i18next.ts` and the two entry files.

## Consequences

- No dependency whose version is dictated by which router we are on.
- A fresh i18next instance is created per server request. Sharing one across
  requests would let two shops rendering in different languages race on the
  global language — a real bug, not a theoretical one, since the admin serves
  many shops from one process.
- The client initialises i18next _before_ hydration, reading the locale from
  the `lang` the server already put on `<html>`. Initialising after would
  hydrate English markup into an Arabic tree and mismatch on every RTL page.

## Locale detection, and why there is no cookie

Order: `?locale=` (Shopify puts the staff member's admin language on every
embedded document request) → `Accept-Language` → English.

No cookie. Third-party cookies are unreliable inside the admin iframe — that is
substantially why App Bridge exists — so a cookie would work for some merchants
and silently not for others.

The consequence is a rule worth stating: **translate in components, not in
loaders.** On a client-side navigation there is no `?locale=`, and the client
i18next instance already holds the right language, so components are correct
and a loader guessing from the request would not be. Anything that must produce
translated text on the server — notification emails, agent replies, storefront
copy — reads the shop's stored locale explicitly via `getShopT()`, because
"whatever language the admin happens to be open in" is the wrong answer for a
buyer-facing string anyway.

## Guard rails

- `tests/unit/i18n-catalogs.test.ts` fails on a key present in one catalog and
  not the other, a blank string, mismatched `{{placeholders}}`, or an English
  string left sitting in the Arabic file.
- `tests/e2e/smoke.spec.ts` asserts that none of the English install copy
  appears on the Arabic page. That is what caught a hardcoded headline during
  this task, which every unit test had passed over.

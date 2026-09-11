import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { expect } from "vitest";

import { dirFor, type Locale } from "~/i18n/config";
import { createI18n } from "~/i18n/i18next";
import en from "~/i18n/locales/en.json";

/**
 * Rendering admin screens to HTML so their states can be asserted, and looked at.
 *
 * The embedded admin cannot be driven outside the Shopify iframe, and this
 * environment has no egress to the Polaris CDN, so `s-*` elements never upgrade
 * to real components. What a capture proves is which content and which states
 * render — not what a merchant sees. Every captured page says so at the top,
 * because a screenshot that looks like a product is the easiest way to convince
 * yourself you have checked something you have not.
 */

const STYLES = `
 body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
   margin:0;padding:1.5rem;background:#f6f6f7;color:#1c1d2b}
 .note{background:#fff4e4;border:1px solid #e0b252;border-radius:8px;padding:.75rem 1rem;
   margin-bottom:1.25rem;font-size:12px;color:#5e4200}
 s-page,s-section,s-box{display:block}
 s-section,s-box{background:#fff;border:1px solid #e3e3e3;border-radius:10px;
   padding:1rem;margin-bottom:1rem}
 s-stack{display:flex;gap:.45rem}
 s-stack[direction=block]{flex-direction:column;align-items:flex-start}
 s-stack[direction=inline]{flex-direction:row;align-items:center;flex-wrap:wrap}
 s-heading{display:block;font-weight:700;margin:.25rem 0}
 s-page[heading]::before{content:attr(heading);display:block;font-size:20px;
   font-weight:800;margin-bottom:1rem}
 s-section[heading]::before{content:attr(heading);display:block;font-weight:700;
   margin-bottom:.5rem}
 s-banner[heading]::before{content:attr(heading);display:block;font-weight:700}
 s-paragraph{display:block;margin:.35rem 0}
 s-banner{display:block;border-inline-start:4px solid #8a8a8a;background:#fafafa;
   padding:.75rem 1rem;margin:.5rem 0;border-radius:6px}
 s-banner[tone=critical]{border-color:#d64545;background:#fdeaea}
 s-banner[tone=warning]{border-color:#b7791f;background:#fff2dd}
 s-banner[tone=info]{border-color:#2f6bd6;background:#eaf1ff}
 s-banner[tone=success]{border-color:#1f8a53;background:#e7f7ee}
 s-badge{display:inline-block;background:#eef0ff;color:#4f46e5;border-radius:999px;
   padding:.1rem .55rem;font-size:12px;margin-inline-end:.4rem}
 /* Tones, so a capture can show what the checklist asks for — "overdue rows
    red" is not verifiable against a page where every badge looks the same. */
 s-badge[tone=critical]{background:#fdeaea;color:#a11f1f}
 s-badge[tone=warning]{background:#fff2dd;color:#7a5200}
 s-badge[tone=success]{background:#e7f7ee;color:#166b41}
 s-badge[tone=neutral]{background:#f0f0f0;color:#4a4a4a}
 s-button{display:inline-block;background:#4f46e5;color:#fff;border-radius:8px;
   padding:.45rem .9rem;margin-inline-end:.5rem;font-weight:700}
 s-button[variant=tertiary]{background:transparent;color:#4f46e5;font-weight:600}
 s-button[disabled]{opacity:.45}
 s-table{display:table;width:100%;border-collapse:collapse}
 s-table-body{display:table-row-group}
 s-table-header-row,s-table-row{display:table-row}
 s-table-header,s-table-cell{display:table-cell;padding:.4rem .5rem;
   border-bottom:1px solid #eee;text-align:start;vertical-align:top}
 s-table-header{font-weight:700}
 s-text-field,s-number-field,s-money-field,s-select,s-text-area,s-date-field,
 s-search-field,s-checkbox{display:block;margin:.4rem 0}
 s-text-field::before,s-number-field::before,s-money-field::before,
 s-select::before,s-text-area::before,s-date-field::before,
 s-search-field::before,s-checkbox::before{content:attr(label);display:block;
   font-weight:600;font-size:12px;margin-bottom:.15rem}
 /* The help text under a field, and whether a box is ticked.
    Both were invisible in every capture ever taken, because the stand-in had
    no rule for either — and on a settings page "details" carries most of the
    "what this change affects" copy and "checked" is the whole point of the
    control. The stand-in only shows what it has a rule for: an attribute with
    no rule reads as absent, however many assertions pass on it. Only two
    pseudo-elements exist per element and "::after" is the value, so the help
    text rides with the label. */
 s-text-field[details]::before,s-number-field[details]::before,
 s-money-field[details]::before,s-select[details]::before,
 s-text-area[details]::before,s-date-field[details]::before{
   content:attr(label) "\\A" attr(details);white-space:pre-wrap;font-weight:600}
 s-checkbox::before{content:"☐  " attr(label)}
 s-checkbox[checked]::before{content:"☑  " attr(label)}
 s-checkbox[details]::before{content:"☐  " attr(label) "\\A" attr(details);
   white-space:pre-wrap}
 s-checkbox[checked][details]::before{content:"☑  " attr(label) "\\A" attr(details);
   white-space:pre-wrap}
 s-text-field::after,s-number-field::after,s-money-field::after,
 s-select::after,s-text-area::after,s-date-field::after{
   content:attr(value);display:block;border:1px solid #d5d5d5;border-radius:6px;
   padding:.35rem .5rem;min-height:1.1em;background:#fff;color:#444}
 /* Errors are red, inline, beside the field — a convention a capture cannot
    show unless the stand-in renders the attribute. "terms-settings-error" was
    byte-identical to "terms-settings" for three milestones because of this. */
 s-text-field[error],s-number-field[error],s-money-field[error],
 s-select[error],s-text-area[error],s-date-field[error],s-checkbox[error]{
   border-inline-start:3px solid #d64545;padding-inline-start:.5rem}
 s-text-field[error]::after,s-number-field[error]::after,s-money-field[error]::after,
 s-select[error]::after,s-text-area[error]::after,s-date-field[error]::after{
   content:attr(value) "\\A⚠ " attr(error);white-space:pre-wrap;
   border-color:#d64545;background:#fdeaea;color:#8a1f1f}
 s-checkbox[error]::after{content:"⚠ " attr(error);display:block;
   color:#8a1f1f;font-size:12px}
 s-ordered-list{display:block;padding-inline-start:1.2rem}
 s-unordered-list{display:block;padding-inline-start:1.1rem}
 s-list-item{display:list-item;margin:.3rem 0}
 s-link{color:#4f46e5;text-decoration:underline;margin-inline-end:.6rem}
 s-text[accessibilityvisibility=exclusive]{position:absolute;width:1px;height:1px;
   overflow:hidden;clip-path:inset(50%)}
 ui-save-bar{display:none}
 /* A real s-select renders its own menu; here the options would otherwise
    print as a run-on line of text next to the field. */
 s-option{display:none}
`;

/**
 * Catalog roots that must never reach the page as literal text.
 *
 * i18next falls back to the key when it cannot resolve one — a pluralised key
 * called without a count is the usual way — and the merchant reads
 * "applications.reason.met.years_in_business". Invisible to anyone skimming a
 * screenshot, so it is checked on every capture.
 */
/**
 * Every top-level key in the English catalogue.
 *
 * Derived rather than listed. A hand-written list is a registration step to
 * forget, and forgetting it switches the guard off for a whole page family
 * silently — which has now happened twice: 4.2 added `describe` and 5.3 added
 * `agent`, and in both cases the captures were unchecked until somebody
 * noticed.
 */
const CATALOG_ROOTS = Object.keys(en as Record<string, unknown>);

/**
 * Text that is deliberately a catalog key.
 *
 * Settings → Translations shows a merchant the key of every string they may
 * rewrite, so on that one page `forms.submit` as visible text is the feature
 * rather than a leak. An element opts out by carrying `data-string-key`, and
 * only the text inside that element is exempt — the rest of the page is still
 * checked, which is what switching the guard off per page would have thrown
 * away.
 */
const LITERAL_KEY_TEXT = /(<[a-z-]+[^>]*\sdata-string-key="[^"]*"[^>]*>)[^<]*/g;

export function expectNoRawCatalogKeys(rendered: string, name: string) {
  const html = rendered.replace(LITERAL_KEY_TEXT, "$1");
  for (const root of CATALOG_ROOTS) {
    expect(html, `${name}: a raw "${root}." catalog key reached the markup`).not.toMatch(
      new RegExp(`>[^<]*\\b${root}\\.[a-zA-Z_]`),
    );
  }
}

/**
 * Two captures in a set must not be the same render.
 *
 * A capture set is read as a set: a reader opening `05-queue-screening-
 * unavailable.png` believes it shows something `04-queue-ideal.png` does not.
 * When both were rendered from the same props, the set claims more states than
 * it contains — and nobody notices, because each test still passes its own
 * assertion against the one page they share.
 *
 * This has happened six times across five milestones. It is checked here
 * rather than by eye.
 */
export function expectDistinct(
  seen: Map<string, string>,
  name: string,
  html: string,
  locale: Locale,
) {
  const key = createHash("sha256").update(`${locale}\u0000${html}`).digest("hex");
  const first = seen.get(key);
  expect(
    first,
    `${name}: identical to "${first}" — one of them does not show the state its name claims`,
  ).toBeUndefined();
  seen.set(key, name);
}

export interface CaptureHarness {
  render: (node: React.ReactNode, locale?: Locale) => string;
  capture: (
    name: string,
    html: string,
    locale?: Locale,
    /** Overrides the standing "structure only" note — see `REAL_NOTE`. */
    note?: string,
  ) => void;
}

const STAND_IN_NOTE = `<strong>QA capture — structure only.</strong> Polaris web components
are not upgraded here: this build environment has no egress to Shopify's CDN, so the
styling below is a plain stand-in and is <em>not</em> what a merchant sees. What this
capture verifies is which content and which states render.`;

/**
 * For pages that are not Polaris. The buyer-facing form is plain HTML with the
 * merchant's own colours, so its capture is the real thing — saying otherwise
 * would understate what has been checked.
 */
export const REAL_NOTE = `<strong>QA capture — the real page.</strong> This screen is plain
HTML styled by the merchant's own appearance settings, not Polaris, so what you see here
is what a buyer sees.`;

/**
 * Build the harness for one task's captures.
 *
 * `outFor` maps a capture name to its directory, so a test file that spans two
 * tasks can send each state to the right place.
 */
export async function createCaptureHarness(options: {
  title: string;
  outFor: (name: string) => string;
  dirs: string[];
  enabled?: boolean;
}): Promise<CaptureHarness> {
  const enabled = options.enabled ?? process.env.QA_CAPTURE === "1";
  const instances = new Map<Locale, Awaited<ReturnType<typeof createI18n>>>();
  /** Markup already captured in this set, by name — see `expectDistinct`. */
  const seen = new Map<string, string>();

  for (const locale of ["en", "ar"] as Locale[]) {
    instances.set(locale, await createI18n(locale));
  }

  if (enabled) {
    for (const dir of options.dirs) mkdirSync(dir, { recursive: true });
  }

  return {
    render(node, locale: Locale = "en") {
      return renderToStaticMarkup(
        <I18nextProvider i18n={instances.get(locale)!}>{node}</I18nextProvider>,
      );
    },

    capture(name, html, locale: Locale = "en", note: string = STAND_IN_NOTE) {
      // Checked whether or not captures are being written: a raw key is a bug
      // in the page, not in the capture.
      expectNoRawCatalogKeys(html, name);
      expectDistinct(seen, name, html, locale);
      if (!enabled) return;
      writeFileSync(
        resolve(options.outFor(name), `${name}.html`),
        `<!doctype html><html lang="${locale}" dir="${dirFor(locale)}"><head>
<meta charset="utf-8"><title>${options.title} — ${name}</title><style>${STYLES}</style></head><body>
<div class="note">${note}</div>
${html}</body></html>\n`,
      );
    },
  };
}

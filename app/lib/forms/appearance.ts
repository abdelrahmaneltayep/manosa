/**
 * How a form looks, and the bounds it is kept inside.
 *
 * A merchant can pick a width; they cannot pick 4 pixels. Clamping here rather
 * than in the form control means a value that arrives from a CSV, an API or a
 * hand-edited request is bounded too.
 */

export const MIN_WIDTH = 320;
export const MAX_WIDTH = 1200;
export const DEFAULT_WIDTH = 640;

export const LAYOUTS = ["default", "boxed"] as const;
export type Layout = (typeof LAYOUTS)[number];

export const FONTS = ["system", "serif", "mono"] as const;
export type FontChoice = (typeof FONTS)[number];

/** Real stacks, so a themed form does not fall back to Times New Roman. */
export const FONT_STACKS: Record<FontChoice, string> = {
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Naskh Arabic", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

export interface Appearance {
  layout: Layout;
  width: number;
  font: FontChoice;
  background: string;
  text: string;
  accent: string;
  accentText: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  layout: "default",
  width: DEFAULT_WIDTH,
  font: "system",
  background: "#ffffff",
  text: "#1c1d2b",
  accent: "#4f46e5",
  accentText: "#ffffff",
};

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const color = (value: unknown, fallback: string) =>
  typeof value === "string" && HEX.test(value.trim()) ? value.trim() : fallback;

export function clampWidth(value: unknown): number {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

/** Never throws. An unreadable stored value falls back to the defaults. */
export function readAppearance(value: unknown): Appearance {
  const node = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;

  return {
    layout: (LAYOUTS as readonly string[]).includes(String(node.layout))
      ? (node.layout as Layout)
      : DEFAULT_APPEARANCE.layout,
    width: clampWidth(node.width ?? DEFAULT_WIDTH),
    font: (FONTS as readonly string[]).includes(String(node.font))
      ? (node.font as FontChoice)
      : DEFAULT_APPEARANCE.font,
    background: color(node.background, DEFAULT_APPEARANCE.background),
    text: color(node.text, DEFAULT_APPEARANCE.text),
    accent: color(node.accent, DEFAULT_APPEARANCE.accent),
    accentText: color(node.accentText, DEFAULT_APPEARANCE.accentText),
  };
}

export interface PublishSettings {
  /** Where the buyer lands after submitting. Empty means our thank-you page. */
  redirectUrl: string;
  /** Tags applied when the application is approved (phase 2.3). */
  autoTags: string[];
  /** Group the approved buyer joins. */
  autoGroupId: string | null;
  /** Honeypot and rate limiting. On by default, per the checklist. */
  spamProtection: boolean;
}

export const DEFAULT_PUBLISH: PublishSettings = {
  redirectUrl: "",
  autoTags: [],
  autoGroupId: null,
  spamProtection: true,
};

/**
 * A redirect a merchant typed has to be safe to send a buyer to.
 *
 * Only http(s), and no credentials in the URL — an `https://user:pass@evil` in
 * a redirect field is a phishing link the merchant did not know they published.
 */
export function isSafeRedirect(value: string): boolean {
  if (!value.trim()) return true;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

export function readPublish(value: unknown): PublishSettings {
  const node = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;

  return {
    redirectUrl:
      typeof node.redirectUrl === "string" && isSafeRedirect(node.redirectUrl)
        ? node.redirectUrl.trim()
        : "",
    autoTags: Array.isArray(node.autoTags)
      ? node.autoTags.filter((tag): tag is string => typeof tag === "string")
      : [],
    autoGroupId: typeof node.autoGroupId === "string" ? node.autoGroupId : null,
    // Defaults to on: a form with spam protection accidentally off fills a
    // merchant's queue with junk, and they will blame the app, correctly.
    spamProtection: node.spamProtection !== false,
  };
}

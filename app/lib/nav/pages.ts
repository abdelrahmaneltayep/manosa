/**
 * The nine admin pages, in sidebar order (spec §"Sidebar Navigation").
 *
 * Only keys live here — the strings themselves are in app/i18n/locales. The
 * `phase` field is what each stub reports until its feature set lands.
 */
export interface NavPage {
  /** Route path under /app. Empty string = the index (Home). */
  readonly path: string;
  /** Key under `nav.` and `page.` in the catalogs. */
  readonly key: string;
  /** Build phase that replaces the stub. */
  readonly phase: string;
}

export const NAV_PAGES: readonly NavPage[] = [
  { path: "", key: "home", phase: "4.5" },
  { path: "pricing", key: "pricing", phase: "1.3" },
  { path: "customers", key: "customers", phase: "2.1" },
  { path: "forms", key: "forms", phase: "2.2" },
  { path: "orders", key: "orders", phase: "3.1" },
  { path: "storefront-agent", key: "storefrontAgent", phase: "5.2" },
  { path: "analytics", key: "analytics", phase: "6.1" },
  { path: "settings", key: "settings", phase: "6.2" },
  { path: "plans", key: "plans", phase: "0.3" },
] as const;

export function navHref(page: NavPage): string {
  return page.path ? `/app/${page.path}` : "/app";
}

/** Catalog key for a page's sidebar label. */
export function navLabelKey(page: NavPage): string {
  return `nav.${page.key}`;
}

/** Catalog key for a page's one-line description. */
export function pageDescriptionKey(page: NavPage): string {
  return `page.${page.key}.description`;
}

/** Route file that must exist for this nav entry to resolve. */
export function routeFileFor(page: NavPage): string {
  return page.path ? `app.${page.path}.tsx` : "app._index.tsx";
}

/**
 * The nine admin pages, in sidebar order (spec §"Sidebar Navigation").
 *
 * Labels carry their i18n key alongside an English default. Phase 0.2 swaps
 * `defaultLabel` for a real `t(i18nKey)` call in one place instead of touching
 * every route.
 */
export interface NavPage {
  /** Route path under /app. Empty string = the index (Home). */
  readonly path: string;
  readonly i18nKey: string;
  readonly defaultLabel: string;
  /** Shown as the s-page heading and in the browser title. */
  readonly i18nDescriptionKey: string;
  readonly defaultDescription: string;
}

export const NAV_PAGES: readonly NavPage[] = [
  {
    path: "",
    i18nKey: "nav.home",
    defaultLabel: "Home",
    i18nDescriptionKey: "page.home.description",
    defaultDescription:
      "Your wholesale command center — KPIs, the Merchant Agent briefing, and what needs you today.",
  },
  {
    path: "pricing",
    i18nKey: "nav.pricing",
    defaultLabel: "Pricing",
    i18nDescriptionKey: "page.pricing.description",
    defaultDescription:
      "Every price rule in one place: volume tiers, custom prices, discounts, priority and combinations.",
  },
  {
    path: "customers",
    i18nKey: "nav.customers",
    defaultLabel: "Customers",
    i18nDescriptionKey: "page.customers.description",
    defaultDescription:
      "Approve wholesale applications, manage groups and tiers, and keep tags in sync.",
  },
  {
    path: "forms",
    i18nKey: "nav.forms",
    defaultLabel: "Forms",
    i18nDescriptionKey: "page.forms.description",
    defaultDescription:
      "Build and publish the registration form buyers fill in to apply for wholesale.",
  },
  {
    path: "orders",
    i18nKey: "nav.orders",
    defaultLabel: "Orders",
    i18nDescriptionKey: "page.orders.description",
    defaultDescription:
      "Wholesale orders, order limits, net payment terms, quotes and draft orders.",
  },
  {
    path: "storefront-agent",
    i18nKey: "nav.storefrontAgent",
    defaultLabel: "Storefront Agent",
    i18nDescriptionKey: "page.storefrontAgent.description",
    defaultDescription:
      "Configure the Buyer Agent your wholesale customers chat with, and review every conversation.",
  },
  {
    path: "analytics",
    i18nKey: "nav.analytics",
    defaultLabel: "Analytics",
    i18nDescriptionKey: "page.analytics.description",
    defaultDescription:
      "Wholesale revenue, rule performance, the registration funnel and net-terms aging.",
  },
  {
    path: "settings",
    i18nKey: "nav.settings",
    defaultLabel: "Settings",
    i18nDescriptionKey: "page.settings.description",
    defaultDescription:
      "Price display, discount combinations, notifications, translations, agent controls and the audit log.",
  },
  {
    path: "plans",
    i18nKey: "nav.plans",
    defaultLabel: "Plans",
    i18nDescriptionKey: "page.plans.description",
    defaultDescription:
      "Your plan, what it includes, and an honest recommendation based on how you actually use Mannon.",
  },
] as const;

export function navHref(page: NavPage): string {
  return page.path ? `/app/${page.path}` : "/app";
}

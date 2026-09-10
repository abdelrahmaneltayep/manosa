/**
 * What the storefront-block specs stub into the page.
 *
 * The blocks call `window.fetch` and `window.Shopify.routes`; the specs replace
 * both. Calls are reported through `__mannonRecord`, a Playwright binding, so
 * they survive the navigation that adding to a cart performs.
 */
declare global {
  interface Window {
    __mannonRecord: (url: string, method: string, body: string) => void;
    Shopify?: { routes?: { root?: string } };
  }
}

export {};

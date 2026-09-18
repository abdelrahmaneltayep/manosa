/**
 * Every URL in `shopify.app.toml`, found once and used twice.
 *
 * The file names the app's own origin in five places — `application_url`, the
 * three OAuth redirects and the App Proxy — and all five have said
 * `https://localhost:3000` since 0.1. Shopify calls every one of them, so a
 * submission on that file is rejected before anybody reads the listing.
 *
 * The reason it stayed wrong is not that nobody noticed; `PROGRESS.md` has
 * said so since 3.4. It is that "the app's URL" was five strings a person had
 * to remember to change together, in a file the Shopify CLI itself rewrites on
 * every `shopify app dev` (`automatically_update_urls_on_dev = true`). So this
 * module makes it one value: `SHOPIFY_APP_URL`, which the app already refuses
 * to boot without and already uses for these exact callbacks at runtime.
 *
 * The scanner here is the *same* one `submission.server.ts` reports on, so the
 * check that says a URL is wrong and the command that fixes it can never
 * disagree about which URLs there are.
 */

/** Hosts that mean "this was never deployed". */
export const LOCAL_HOST = /localhost|127\.0\.0\.1|\.ngrok|trycloudflare|\.local\b/;

export interface AppUrlSite {
  /** `application_url`, `auth.redirect_urls` or `app_proxy.url`. */
  key: string;
  url: string;
  /** Where the quoted value sits in the file, so a rewrite can be exact. */
  start: number;
  end: number;
}

const ASSIGNMENT = /^[ \t]*(application_url|url)[ \t]*=[ \t]*"([^"]*)"/gm;
const REDIRECTS = /^[ \t]*redirect_urls[ \t]*=[ \t]*\[([^\]]*)\]/gm;
const TABLE = /^[ \t]*\[([^\]]+)\]/gm;
const QUOTED = /"([^"]*)"/g;

/** The table header a given offset sits under, for a report a person can act on. */
function tableAt(toml: string, offset: number): string | null {
  let current: string | null = null;
  for (const match of toml.matchAll(TABLE)) {
    if (match.index! > offset) break;
    current = match[1]!;
  }
  return current;
}

/**
 * Every place the file states the app's origin.
 *
 * Ordered by position, so a report reads in the order a person scrolls.
 */
export function appUrlSites(toml: string): AppUrlSite[] {
  const sites: AppUrlSite[] = [];

  for (const match of toml.matchAll(ASSIGNMENT)) {
    const url = match[2]!;
    const start = match.index! + match[0].lastIndexOf(`"${url}"`) + 1;
    const table = tableAt(toml, match.index!);
    sites.push({
      key: table ? `${table}.${match[1]}` : match[1]!,
      url,
      start,
      end: start + url.length,
    });
  }

  for (const array of toml.matchAll(REDIRECTS)) {
    const body = array[1]!;
    const bodyStart = array.index! + array[0].indexOf(body);
    const table = tableAt(toml, array.index!);
    for (const quoted of body.matchAll(QUOTED)) {
      const start = bodyStart + quoted.index! + 1;
      sites.push({
        key: table ? `${table}.redirect_urls` : "redirect_urls",
        url: quoted[1]!,
        start,
        end: start + quoted[1]!.length,
      });
    }
  }

  return sites.sort((a, b) => a.start - b.start);
}

/**
 * Why this is not an origin Shopify can call, or null when it is.
 *
 * Returned as a sentence rather than thrown, because both callers want to
 * print it: the deploy script refuses, and the readiness check reports.
 */
export function whyNotDeployable(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `"${value}" is not a URL.`;
  }

  if (url.protocol !== "https:") {
    return `${value} is not https. Shopify refuses to call an app over http.`;
  }
  if (LOCAL_HOST.test(url.host)) {
    return `${url.host} is a development host. It is reachable from your machine and from nowhere Shopify runs.`;
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return `${value} has a path. This is the app's origin — the paths are already in the file.`;
  }
  return null;
}

export interface Rewrite {
  toml: string;
  /** Only the sites whose text actually changed. */
  changed: { key: string; from: string; to: string }[];
}

/**
 * The same file, with every origin replaced and every path kept.
 *
 * Only the origin moves. `/auth/callback` and `/proxy` are this app's routes
 * and are not the deployer's to retype — a rewrite that rebuilt the whole
 * string could drop one and nothing would notice until OAuth failed on a real
 * store.
 */
export function withAppUrl(toml: string, appUrl: string): Rewrite {
  const reason = whyNotDeployable(appUrl);
  if (reason) throw new Error(reason);

  const origin = new URL(appUrl).origin;
  const changed: Rewrite["changed"] = [];
  let out = "";
  let cursor = 0;

  for (const site of appUrlSites(toml)) {
    let next: string;
    try {
      const existing = new URL(site.url);
      next = origin + (existing.pathname === "/" ? "" : existing.pathname);
    } catch {
      // A value that was never a URL keeps whatever path it looks like it has,
      // rather than being silently replaced by a bare origin.
      next = origin;
    }

    out += toml.slice(cursor, site.start) + next;
    cursor = site.end;
    if (next !== site.url) changed.push({ key: site.key, from: site.url, to: next });
  }

  return { toml: out + toml.slice(cursor), changed };
}

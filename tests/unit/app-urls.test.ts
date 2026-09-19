import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { appUrlSites, whyNotDeployable, withAppUrl } from "~/lib/release/app-urls";

/**
 * The app's own origin, in the file Shopify reads.
 *
 * Five strings, all `https://localhost:3000` since 0.1, in a file the Shopify
 * CLI rewrites on every `shopify app dev`. The thing under test is not "can a
 * string be replaced" — it is that no site is missed, no route is invented,
 * and nothing that is not a deployable origin gets written.
 */

const LIVE = readFileSync(resolve(process.cwd(), "shopify.app.toml"), "utf8");

describe("finding every URL in the app config", () => {
  it("finds all five in the file that ships", () => {
    // Against the real file, not a fixture: a fixture would keep passing the
    // day somebody adds a sixth URL to the config.
    const sites = appUrlSites(LIVE);

    expect(sites.map((site) => site.key)).toEqual([
      "application_url",
      "auth.redirect_urls",
      "auth.redirect_urls",
      "auth.redirect_urls",
      "app_proxy.url",
    ]);
  });

  it("names the table each one lives under, so a report can be acted on", () => {
    const proxy = appUrlSites(LIVE).find((site) => site.key === "app_proxy.url");
    expect(proxy?.url.endsWith("/proxy")).toBe(true);
  });

  it("reads the offsets exactly, so a rewrite touches nothing else", () => {
    for (const site of appUrlSites(LIVE)) {
      expect(LIVE.slice(site.start, site.end)).toBe(site.url);
    }
  });
});

describe("what may be written into the file", () => {
  it("refuses a development host", () => {
    for (const url of [
      "https://localhost:3000",
      "https://127.0.0.1:3000",
      "https://plenty-cats-jump.ngrok.io",
      "https://odd-name.trycloudflare.com",
      "https://mannon.local",
    ]) {
      expect(whyNotDeployable(url), url).toContain("development host");
    }
  });

  it("refuses http, which Shopify will not call", () => {
    expect(whyNotDeployable("http://mannon.example.com")).toContain("not https");
  });

  it("refuses an origin with a path, which would double the routes", () => {
    // `https://host/app` plus `/auth/callback` is `https://host/app` again —
    // the paths are already in the file and are not the deployer's to retype.
    expect(whyNotDeployable("https://mannon.example.com/app")).toContain("has a path");
  });

  it("refuses something that is not a URL at all", () => {
    expect(whyNotDeployable("mannon.example.com")).toContain("not a URL");
    expect(whyNotDeployable("")).toContain("not a URL");
  });

  it("accepts a real origin", () => {
    expect(whyNotDeployable("https://mannon.example.com")).toBeNull();
    expect(whyNotDeployable("https://mannon.example.com:8443")).toBeNull();
  });
});

describe("pointing the config at a deployed app", () => {
  it("moves every origin and keeps every path", () => {
    const { toml, changed } = withAppUrl(LIVE, "https://wholesale.example.com");

    expect(changed).toHaveLength(5);
    expect(appUrlSites(toml).map((site) => site.url)).toEqual([
      "https://wholesale.example.com",
      "https://wholesale.example.com/auth/callback",
      "https://wholesale.example.com/auth/shopify/callback",
      "https://wholesale.example.com/api/auth/callback",
      "https://wholesale.example.com/proxy",
    ]);
  });

  it("leaves the rest of the file alone", () => {
    // Whatever the file points at today — it is generated, so hard-coding the
    // origin here would make this test something to edit on every re-deploy
    // rather than something that checks a rewrite.
    const current = new URL(appUrlSites(LIVE)[0]!.url).origin;
    const { toml } = withAppUrl(LIVE, "https://wholesale.example.com");

    // The scopes, the webhook topics and the compliance keys are the parts a
    // careless rewrite would take with it.
    expect(toml.replace(/https:\/\/wholesale\.example\.com/g, current)).toBe(LIVE);
  });

  it("gives the root URL no trailing slash", () => {
    // `new URL("https://h").toString()` is `"https://h/"`, and Shopify treats
    // the two as different origins on the redirect allow-list.
    const { toml } = withAppUrl(LIVE, "https://wholesale.example.com");
    expect(toml).toContain('application_url = "https://wholesale.example.com"');
  });

  it("is idempotent, and says nothing changed", () => {
    const once = withAppUrl(LIVE, "https://wholesale.example.com");
    const twice = withAppUrl(once.toml, "https://wholesale.example.com");

    expect(twice.changed).toEqual([]);
    expect(twice.toml).toBe(once.toml);
  });

  it("writes nothing at all rather than a URL it would not accept", () => {
    expect(() => withAppUrl(LIVE, "https://localhost:3000")).toThrow("development host");
    expect(() => withAppUrl(LIVE, "not-a-url")).toThrow("not a URL");
  });

  it("moves a config that is already deployed to a new host", () => {
    // A re-deploy behind a new domain, which is the case that would otherwise
    // be done by hand five times.
    const deployed = withAppUrl(LIVE, "https://old.example.com").toml;
    const { toml, changed } = withAppUrl(deployed, "https://new.example.com");

    expect(changed).toHaveLength(5);
    expect(toml).not.toContain("old.example.com");
  });
});

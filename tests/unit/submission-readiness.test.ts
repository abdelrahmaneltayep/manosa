import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { formatReadiness, submissionReadiness } from "~/lib/release/submission.server";

/**
 * The submission check tells the truth about this repository.
 *
 * It is deliberately not a compliance report — Shopify's own requirements live
 * at `shopify.dev`, which this environment cannot reach, and inventing them
 * from memory would be exactly the kind of claim this repo keeps catching. What
 * it checks is the subset that is objectively true or false about these files,
 * and what this test checks is that it still notices.
 *
 * The case that matters: `shopify.app.toml` has pointed at
 * `https://localhost:3000` since 0.1 and `PROGRESS.md` has said so since 3.4.
 * A submission on that file is rejected before a human reads the listing, and
 * until now nothing anywhere failed because of it.
 */

const checks = submissionReadiness();
const byId = new Map(checks.map((one) => [one.id, one]));

/**
 * The same checks, against a config that was never deployed.
 *
 * The repository only ever holds one answer at a time, so once the URLs became
 * real nothing could reach the branch that catches a development host — on the
 * check whose whole job is to fail before a submission does.
 */
const asIfUndeployed = () => {
  const real = readFileSync(resolve(process.cwd(), "shopify.app.toml"), "utf8");
  const local = real.replace(/https:\/\/manosa\.fly\.dev/g, "https://localhost:3000");
  return submissionReadiness((path) =>
    path === "shopify.app.toml"
      ? local
      : readFileSync(resolve(process.cwd(), path), "utf8"),
  );
};

describe("the submission check", () => {
  it("passes now the URLs are the deployed app's", () => {
    const urls = byId.get("urls")!;

    expect(urls.status).toBe("ready");
    expect(urls.detail).toContain("manosa.fly.dev");
    // The word appears in the reassurance ("no localhost, tunnel or…"); what
    // must not appear is a URL pointing at one.
    expect(urls.detail).not.toContain("https://localhost");
  });

  it("still catches a development host, and names every one of them", () => {
    const urls = new Map(asIfUndeployed().map((one) => [one.id, one])).get("urls")!;

    expect(urls.status).toBe("blocked");
    expect(urls.detail).toContain("localhost");

    // All five, each named by the key it sits under. Counting them was not
    // enough: "3 URLs point at localhost" leaves a person hunting the file for
    // which three, and the App Proxy line is the one nobody thinks to check.
    expect(urls.detail).toContain("5 of 5");
    for (const key of ["application_url", "auth.redirect_urls", "app_proxy.url"]) {
      expect(urls.detail, key).toContain(key);
    }

    // And the way out, in the words that run it. "Set them to the deployed
    // app URL" described five hand edits to a file the Shopify CLI rewrites
    // on every `shopify app dev`.
    expect(urls.detail).toContain("SHOPIFY_APP_URL");
    expect(urls.detail).toContain("npm run config:urls");
  });

  it("knows the privacy topics are declared under the key Shopify reads", () => {
    // The one that shipped wrong: declared as `topics`, they register with
    // nobody and the whole feature is inert.
    expect(byId.get("gdpr")!.status).toBe("ready");
  });

  it("confirms the things this repo actually does", () => {
    for (const id of ["uninstall", "embedded", "billing"]) {
      expect(byId.get(id)!.status, id).toBe("ready");
    }
  });

  it("says plainly what it cannot know from here", () => {
    // A check that quietly passed the listing copy, the privacy policy or a
    // dev-store run would be the report claiming something nobody did.
    for (const id of ["listing", "privacy-policy", "dev-store", "performance"]) {
      expect(byId.get(id)!.status, id).toBe("unverifiable");
    }
  });

  it("gives every check a reason somebody can act on", () => {
    for (const one of checks) {
      expect(one.detail.length, one.id).toBeGreaterThan(40);
    }
    expect(checks.length).toBeGreaterThan(6);
  });

  it("reads as a report, and says what it is not", () => {
    const report = formatReadiness(checks);
    expect(report).toContain("not a compliance report");
    expect(report).toContain("Nothing here blocks a submission");

    // And the other half of that sentence, which is the one that matters.
    expect(formatReadiness(asIfUndeployed())).toContain("1 blocker(s)");
  });
});

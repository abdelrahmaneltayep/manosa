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

describe("the submission check", () => {
  it("sees the development URLs that are still in the app config", () => {
    const urls = byId.get("urls")!;

    // Today this is blocked, and that is the correct answer. When the app is
    // deployed and the URLs are real, this flips to ready — and if somebody
    // puts an ngrok tunnel in the file on the way there, it flips back.
    expect(urls.status).toBe("blocked");
    expect(urls.detail).toContain("localhost");
    expect(urls.detail).toContain("Set them to the deployed app URL");
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
    expect(report).toContain("1 blocker(s)");
  });
});

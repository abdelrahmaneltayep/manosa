import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  normalizeTopic,
  subscriptionForTopic,
  WEBHOOK_SUBSCRIPTIONS,
} from "~/lib/webhooks/registry";

/**
 * Parse the `[[webhooks.subscriptions]]` blocks out of shopify.app.toml.
 *
 * Deliberately not a general TOML parser — this asserts on one known shape, and
 * a dependency here would just be another thing to keep current.
 */
function declaredSubscriptions(): {
  topic: string;
  uri: string;
  compliance: boolean;
}[] {
  const toml = readFileSync(resolve(process.cwd(), "shopify.app.toml"), "utf8");
  const blocks = toml.split(/\[\[webhooks\.subscriptions\]\]/).slice(1);

  return blocks.flatMap((block) => {
    const body = block.split(/\n\[/)[0]!;
    const uri = body.match(/uri\s*=\s*"([^"]+)"/)?.[1];
    // The two keys are told apart deliberately. `compliance_topics` ends in
    // `topics`, so a regex for one matches the other — which is how the three
    // mandatory privacy topics shipped under the wrong key, registered with
    // nobody, with this test still green.
    const compliance = /(^|\s)compliance_topics\s*=/.test(body);
    const topicsRaw = body.match(
      /(?:^|\s)(?:compliance_)?topics\s*=\s*\[([^\]]+)\]/,
    )?.[1];
    if (!uri || !topicsRaw) return [];
    return [...topicsRaw.matchAll(/"([^"]+)"/g)].map((m) => ({
      topic: m[1]!,
      uri,
      compliance,
    }));
  });
}

/**
 * Shopify's mandatory privacy topics.
 *
 * They are not registered through the Admin API like every other subscription:
 * `@shopify/shopify-api`'s `register.ts` skips any topic in its `privacyTopics`
 * list. They reach an app only because the app's configuration declares them as
 * `compliance_topics`, and under any other key Shopify is never told where to
 * send them.
 */
const COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"];

describe("webhook registry", () => {
  it("normalises Shopify's topic header format", () => {
    expect(normalizeTopic("app/uninstalled")).toBe("APP_UNINSTALLED");
    expect(normalizeTopic("APP_UNINSTALLED")).toBe("APP_UNINSTALLED");
    expect(normalizeTopic("customers/data_request")).toBe("CUSTOMERS_DATA_REQUEST");
  });

  it("resolves a handler from either topic spelling", () => {
    expect(subscriptionForTopic("app/uninstalled")).toBeDefined();
    expect(subscriptionForTopic("APP_UNINSTALLED")).toBeDefined();
  });

  it("returns nothing for a topic it does not handle", () => {
    expect(subscriptionForTopic("fulfillments/create")).toBeUndefined();
  });

  it("has no duplicate topics or URIs", () => {
    const topics = WEBHOOK_SUBSCRIPTIONS.map((s) => normalizeTopic(s.topic));
    const uris = WEBHOOK_SUBSCRIPTIONS.map((s) => s.uri);
    expect(new Set(topics).size).toBe(topics.length);
    expect(new Set(uris).size).toBe(uris.length);
  });

  /**
   * The two halves of the classic webhook bug:
   *
   *  - a handler with no subscription never runs, and nothing tells you;
   *  - a subscription with no handler 404s, and Shopify retries it for 48h.
   *
   * Both are silent in production and obvious here.
   */
  it("declares every privacy topic under `compliance_topics`, and nothing else", () => {
    const declared = declaredSubscriptions();

    for (const topic of COMPLIANCE_TOPICS) {
      const entry = declared.find((one) => one.topic === topic);
      expect(entry, `${topic} is not declared at all`).toBeDefined();
      expect(entry!.compliance, `${topic} is declared as a plain topic`).toBe(true);
    }

    // And the reverse: an ordinary topic under `compliance_topics` would never
    // be registered either.
    for (const entry of declared.filter((one) => one.compliance)) {
      expect(COMPLIANCE_TOPICS, entry.topic).toContain(entry.topic);
    }
  });

  it("declares exactly the registered topics in shopify.app.toml", () => {
    const declared = declaredSubscriptions();
    expect(declared.length).toBeGreaterThan(0);

    const declaredTopics = declared.map((s) => normalizeTopic(s.topic)).sort();
    const registered = WEBHOOK_SUBSCRIPTIONS.map((s) => normalizeTopic(s.topic)).sort();

    expect(declaredTopics).toEqual(registered);
  });

  it("posts each topic to the URI its handler is registered under", () => {
    for (const declared of declaredSubscriptions()) {
      const subscription = subscriptionForTopic(declared.topic);
      expect(subscription, `no handler for ${declared.topic}`).toBeDefined();
      expect(declared.uri, `URI drift for ${declared.topic}`).toBe(subscription!.uri);
    }
  });

  it("routes every subscription under the /webhooks/ splat route", () => {
    for (const subscription of WEBHOOK_SUBSCRIPTIONS) {
      expect(subscription.uri.startsWith("/webhooks/")).toBe(true);
    }
  });
});

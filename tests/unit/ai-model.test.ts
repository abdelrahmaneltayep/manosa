import { describe, expect, it } from "vitest";

import {
  AI_FEATURES,
  AI_MAX_ATTEMPTS,
  AI_TIMEOUT_MS,
  DEFAULT_MODEL,
  modelId,
  PROMPT_VERSIONS,
} from "~/lib/ai/model";
import { apiKey, isAiAvailable } from "~/lib/ai/client.server";

/**
 * The settings every AI call is made under.
 *
 * Small, but each one is a promise the invariants make: a timeout, one retry,
 * and a product that works with no key at all.
 */

describe("the model", () => {
  it("defaults to what the spec names", () => {
    expect(modelId({})).toBe(DEFAULT_MODEL);
  });

  it("takes an override from the environment, so a newer model is a setting", () => {
    expect(modelId({ MANNON_AI_MODEL: "claude-opus-5" })).toBe("claude-opus-5");
  });

  it("ignores an override that is only whitespace", () => {
    expect(modelId({ MANNON_AI_MODEL: "   " })).toBe(DEFAULT_MODEL);
  });
});

describe("the limits the invariants ask for", () => {
  it("times out at twenty seconds", () => {
    expect(AI_TIMEOUT_MS).toBe(20_000);
  });

  it("tries twice at most — the call and one retry", () => {
    expect(AI_MAX_ATTEMPTS).toBe(2);
  });
});

describe("features", () => {
  it("gives every feature a prompt version, so an old answer stays explicable", () => {
    for (const feature of AI_FEATURES) {
      expect(PROMPT_VERSIONS[feature], feature).toBeTruthy();
    }
    expect(Object.keys(PROMPT_VERSIONS).sort()).toEqual([...AI_FEATURES].sort());
  });
});

describe("availability", () => {
  it("is false with no key, which is a supported state of this product", () => {
    expect(isAiAvailable({})).toBe(false);
    expect(apiKey({})).toBeNull();
  });

  it("treats a blank key as no key rather than as a key", () => {
    expect(isAiAvailable({ ANTHROPIC_API_KEY: "   " })).toBe(false);
  });

  it("is true once a key is set", () => {
    expect(isAiAvailable({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBe(true);
  });
});

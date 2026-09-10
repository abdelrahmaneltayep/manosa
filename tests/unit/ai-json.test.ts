import { describe, expect, it } from "vitest";

import { extractJson } from "~/lib/ai/json.server";

/**
 * Getting JSON out of an answer that may be wrapped.
 *
 * Models fence JSON, add a sentence before it, or both. Recovering from that is
 * not guessing at the content, so it is recovered rather than counted as a
 * failure the merchant waits through.
 */

describe("extractJson", () => {
  it("passes bare JSON through", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
    expect(extractJson('  \n {"a":1}\n ')).toBe('{"a":1}');
  });

  it("unwraps a fenced block, labelled or not", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("drops a sentence in front of an object", () => {
    expect(extractJson('Here is the rule you asked for:\n{"a":1}')).toBe('{"a":1}');
  });

  it("drops a sentence in front of an array", () => {
    expect(extractJson("Sure! [1, 2, 3]")).toBe("[1, 2, 3]");
  });

  it("keeps a nested object whole", () => {
    const value = '{"a":{"b":[1,2]},"c":"}"}';
    expect(extractJson(`Result:\n${value}`)).toBe(value);
  });

  it("prefers the fence when there is both a sentence and a fence", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("returns prose unchanged rather than inventing JSON from it", () => {
    // It will fail to parse, which is the right outcome — the caller falls back
    // rather than acting on something this function made up.
    expect(extractJson("I cannot help with that.")).toBe("I cannot help with that.");
  });

  it("does not mangle an empty answer", () => {
    expect(extractJson("")).toBe("");
    expect(extractJson("   ")).toBe("");
  });
});

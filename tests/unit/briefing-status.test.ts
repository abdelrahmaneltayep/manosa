import { describe, expect, it } from "vitest";

import { briefingStatus } from "~/lib/agent/home-view.server";

/**
 * Which of the six briefing cards a merchant gets.
 *
 * Four of them are ways of saying "there is nothing on the list", and they are
 * four different truths: the agent is switched off, it has never run, it
 * looked and found nothing, or it could not be reached. Collapsing any two of
 * them tells a merchant something that is not true — which is how "All quiet —
 * nothing needs you today" once appeared above six waiting applications.
 */

const input = (overrides: Partial<Parameters<typeof briefingStatus>[0]> = {}) => ({
  agentAvailable: true,
  briefing: {},
  failure: null,
  shown: 0,
  outstanding: 0,
  ...overrides,
});

describe("briefingStatus", () => {
  it("is off before it is anything else", () => {
    // Even with a failure recorded and a briefing on file: a shop without the
    // plan or the key is not owed an apology for a briefing it never had.
    expect(
      briefingStatus(input({ agentAvailable: false, failure: "timeout", shown: 3 })),
    ).toBe("off");
  });

  it("is unavailable when the last attempt failed", () => {
    expect(briefingStatus(input({ failure: "timeout" }))).toBe("unavailable");
    expect(briefingStatus(input({ failure: "timeout", briefing: null }))).toBe(
      "unavailable",
    );
  });

  it("is empty on day one", () => {
    expect(briefingStatus(input({ briefing: null }))).toBe("empty");
  });

  it("is ready when there is something to show", () => {
    expect(briefingStatus(input({ shown: 2, outstanding: 5 }))).toBe("ready");
  });

  it("is quiet only when nothing at all is outstanding", () => {
    expect(briefingStatus(input())).toBe("quiet");
  });

  it("is cleared when the list is done but something else came up", () => {
    expect(briefingStatus(input({ shown: 0, outstanding: 3 }))).toBe("cleared");
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { decodeEnvelope, encodeEnvelope } from "~/lib/setup/envelope.server";

/**
 * The wizard's hidden field, signed.
 *
 * `readSetupPlan` re-validates the plan, so a tampered rule cannot become a bad
 * price. What it cannot check is the provenance — which model, which prompt,
 * which request — and those three go straight into an `AuditLog` row that says
 * a model was involved. An audit entry the client dictates is not an audit
 * entry, which is what the signature is for.
 */

const envelope = () => ({
  plan: { summary: "s", groups: [{ name: "Cafés", tag: "cafes", description: "d" }] },
  model: "claude-sonnet-4-5",
  promptVersion: "1",
  requestId: "req_1",
});

beforeEach(() => {
  process.env.SHOPIFY_API_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.SHOPIFY_API_SECRET;
});

describe("the signed envelope", () => {
  it("comes back as it went out", () => {
    expect(decodeEnvelope(encodeEnvelope(envelope()))).toEqual(envelope());
  });

  it("refuses an envelope whose plan was edited after signing", () => {
    const signed = JSON.parse(encodeEnvelope(envelope())) as {
      body: string;
      signature: string;
    };
    const tampered = JSON.stringify({
      body: signed.body.replace("cafes", "wholesale"),
      signature: signed.signature,
    });

    expect(decodeEnvelope(tampered)).toBeNull();
  });

  it("refuses provenance the client made up", () => {
    // The attack this exists for: writing an audit row attributing a live
    // pricing rule to a model of your choosing.
    const forged = JSON.stringify({
      body: JSON.stringify({ ...envelope(), model: "definitely-not-claude" }),
      signature: "0".repeat(64),
    });

    expect(decodeEnvelope(forged)).toBeNull();
  });

  it("refuses an envelope signed with a different secret", () => {
    const signed = encodeEnvelope(envelope());
    process.env.SHOPIFY_API_SECRET = "a-different-secret";
    expect(decodeEnvelope(signed)).toBeNull();
  });

  it("refuses anything that is not a signed envelope", () => {
    expect(decodeEnvelope("")).toBeNull();
    expect(decodeEnvelope("null")).toBeNull();
    expect(decodeEnvelope("not json")).toBeNull();
    expect(decodeEnvelope(JSON.stringify(envelope()))).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ body: "{}", signature: "" }))).toBeNull();
  });

  it("refuses an envelope with no provenance in it", () => {
    const signed = encodeEnvelope({ ...envelope(), model: "" });
    expect(decodeEnvelope(signed)).toBeNull();
  });

  it("refuses everything when there is no secret to check against", () => {
    delete process.env.SHOPIFY_API_SECRET;
    // Never invented, never defaulted: "we cannot check this" reads as no.
    expect(() => encodeEnvelope(envelope())).toThrow();
    expect(decodeEnvelope("{}")).toBeNull();
  });
});

import {
  MAX_PO_LINES,
  readPoLine,
  type PoLine,
} from "~/lib/ai/prompts/purchase-order.server";

/**
 * What a half-finished purchase order carries between requests.
 *
 * The review screen has no session of its own: the lines Claude read, the
 * buyer, and the merchant's answers to the ambiguous lines all travel in a
 * hidden field and come back on the next post. Which means the field is
 * merchant-editable, so `decode` re-checks every line through the same guard
 * the model's own answer gets — a hand-edited quantity of `-5` must not reach
 * `draftOrderCreate`.
 */
export interface PoEnvelope {
  buyerId: string | null;
  reference: string | null;
  notes: string | null;
  lines: PoLine[];
  /** Merchant answers to ambiguous lines: line index → variant id. */
  chosen: Record<string, string>;
  /** Which model read the document, for the audit entry on approval. */
  model: string;
  promptVersion: string;
  requestId: string | null;
}

export const encode = (envelope: PoEnvelope) => JSON.stringify(envelope);

export function decode(raw: string): PoEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as Partial<PoEnvelope>;
    if (!Array.isArray(envelope.lines) || envelope.lines.length === 0) return null;

    const chosen: Record<string, string> = {};
    for (const [index, id] of Object.entries(envelope.chosen ?? {})) {
      if (typeof id === "string" && id !== "") chosen[index] = id;
    }

    const lines: PoLine[] = [];
    for (const [index, raw] of envelope.lines.slice(0, MAX_PO_LINES).entries()) {
      const line = readPoLine(raw, index);
      if (!line.ok) return null;
      lines.push(line.value);
    }

    // No provenance means no way to trace the order back to what read it, and
    // the audit entry is the only record that a model was involved at all.
    if (typeof envelope.model !== "string" || envelope.model === "") return null;

    return {
      buyerId: typeof envelope.buyerId === "string" ? envelope.buyerId : null,
      reference: typeof envelope.reference === "string" ? envelope.reference : null,
      notes: typeof envelope.notes === "string" ? envelope.notes : null,
      lines,
      chosen,
      model: envelope.model,
      promptVersion: String(envelope.promptVersion ?? ""),
      requestId: typeof envelope.requestId === "string" ? envelope.requestId : null,
    };
  } catch {
    return null;
  }
}

/**
 * Is this text, or is it the bytes of a PDF?
 *
 * A cheap, honest test. A document we cannot read as text gets the checklist's
 * "Couldn't read this — paste the lines as text?" rather than twenty seconds of
 * a model staring at binary.
 */
export function isReadableText(content: string): boolean {
  if (content.startsWith("%PDF")) return false;
  // A .xlsx or .docx is a zip.
  if (content.startsWith("PK")) return false;

  const sample = content.slice(0, 2_000);
  const printable = [...sample].filter((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 || code === 9 || code === 10 || code === 13;
  }).length;

  return sample.length === 0 || printable / sample.length > 0.95;
}

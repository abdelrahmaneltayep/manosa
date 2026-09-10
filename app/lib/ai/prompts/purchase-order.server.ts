import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";

/**
 * ✦ PO-to-order: reading the lines out of a purchase order.
 *
 * Spec §5: a buyer sends a spreadsheet, a PDF, or a plain email — "200 units of
 * the blue one, 50 of each grinder" — and it becomes a draft order at that
 * buyer's contract prices.
 *
 * The model does one thing: turn prose into lines. It does **not** match a SKU
 * (the catalogue does, and the merchant confirms anything ambiguous) and it does
 * **not** price anything — the checklist is explicit: "Totals always recomputed
 * from Mannon rules — never trust the PO's own prices". A price the model reads
 * off the document is carried only so the screen can show the difference.
 */

/** A PO with more lines than this is a data feed, not a purchase order. */
export const MAX_PO_LINES = 200;
/** How much of a document is worth reading. Beyond this it is an attachment. */
export const MAX_PO_CHARS = 20_000;

export interface PoLine {
  /** A SKU or code, when the document gives one. */
  sku: string | null;
  /** What the buyer called it. Used to search when there is no SKU. */
  description: string | null;
  quantity: number;
  /** The price the *document* claims, as a decimal string. Never charged. */
  statedPrice: string | null;
}

export interface PoReading {
  lines: PoLine[];
  /** Their PO number, when the document has one. Goes on the draft order. */
  reference: string | null;
  notes: string | null;
}

export const PO_SYSTEM = `You read a purchase order sent to a wholesale supplier and pull out the lines being ordered.

Answer with a single JSON object and nothing else:

{
  "lines": [ { "sku": string | null, "description": string | null, "quantity": number, "statedPrice": string | null } ],
  "reference": string | null,
  "notes": string | null
}

Rules:
- One entry per thing being ordered, in the order they appear.
- "sku" is a product code exactly as written. If the document gives no code, use null — do not invent one, and do not turn a description into a code.
- "description" is what the buyer called it, in their words. Keep it when there is no SKU; it is what the supplier will search for.
- "quantity" is a whole number of units. If a line says "5 cases of 12", the quantity is what the document asks for in the units it names — say what you did in "notes".
- "statedPrice" is the unit price the document claims, as a plain decimal string with no currency symbol, or null. It is never charged; the supplier's own contract prices are used. It is recorded only so the supplier can see where the two disagree.
- "reference" is the buyer's own PO number, if there is one.
- Ignore headers, footers, addresses, terms, totals and tax lines. You are reading the order lines only.
- If a line's quantity is genuinely unreadable, leave it out and say which one in "notes". A line invented from a guess is worse than a line the supplier types in themselves.
- "notes" is one sentence, or null. Anything you assumed, skipped, or could not read.`;

export function poUser(text: string): string {
  return ["The document:", "", text.slice(0, MAX_PO_CHARS)].join("\n");
}

/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_QUANTITY = 1_000_000;
const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * One line, checked.
 *
 * Exported because the *round trip* needs it as much as the model's answer
 * does: the draft travels in a hidden field, and a hand-edited quantity of -5
 * reached `draftOrderCreate` before this was shared.
 */
export function readPoLine(
  raw: unknown,
  index: number,
): { ok: true; value: PoLine } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `lines[${index}] must be an object.` };

  const quantity = Number(raw.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
    return {
      ok: false,
      error: `lines[${index}].quantity was ${JSON.stringify(raw.quantity)}; it must be a whole number of units.`,
    };
  }

  const sku = readText(raw.sku);
  const description = readText(raw.description);
  if (!sku && !description) {
    return {
      ok: false,
      error: `lines[${index}] has neither a sku nor a description, so nothing can be matched to it.`,
    };
  }

  const statedPrice = readText(raw.statedPrice);
  if (statedPrice !== null && !DECIMAL.test(statedPrice)) {
    return {
      ok: false,
      error: `lines[${index}].statedPrice was "${statedPrice}"; it must be a plain decimal with no symbol, or null.`,
    };
  }

  return { ok: true, value: { sku, description, quantity, statedPrice } };
}

function readText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed.slice(0, 200);
}

export function readPo(
  value: unknown,
): { ok: true; value: PoReading } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "The answer was not a JSON object." };
  if (!Array.isArray(value.lines))
    return { ok: false, error: `"lines" must be an array.` };

  const lines: PoLine[] = [];

  for (const [index, raw] of value.lines.entries()) {
    const line = readPoLine(raw, index);
    if (!line.ok) return line;
    lines.push(line.value);
  }

  if (lines.length === 0) {
    return { ok: false, error: "No order lines could be read from this document." };
  }

  return {
    ok: true,
    value: {
      lines: lines.slice(0, MAX_PO_LINES),
      reference: readText(value.reference),
      notes: readText(value.notes),
    },
  };
}

/** Read a purchase order. Never throws; never orders anything. */
export function readPurchaseOrder(
  text: string,
  options: { actorId?: string | null } = {},
  deps: AiDeps = {},
): Promise<AiResult<PoReading>> {
  return askForJson<PoReading>(
    {
      feature: "po_to_order",
      system: PO_SYSTEM,
      user: poUser(text),
      actorId: options.actorId,
      temperature: 0,
      validate: readPo,
    },
    deps,
  );
}

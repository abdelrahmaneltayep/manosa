/**
 * Parsing the list a buyer pastes into the quick-order form.
 *
 * Wholesale buyers do not type SKUs one at a time. They paste a column out of
 * a spreadsheet, or the body of a purchase order, and what arrives is messy:
 * tabs, commas, semicolons, quantities before the SKU, header rows, blank
 * lines, and a trailing "Total" line that is not a product at all.
 *
 * Every line comes back either as an order line or as a problem with the line
 * number on it. Nothing is silently dropped — a buyer who pastes forty lines
 * and gets thirty-nine in their cart has been failed quietly, which is worse
 * than being told about the fortieth.
 */

export type PasteIssueCode =
  "no_sku" | "no_quantity" | "quantity_not_a_number" | "quantity_too_large" | "duplicate";

export interface PasteLine {
  /** 1-based, as the buyer counts them. */
  lineNumber: number;
  /** The raw text, so an error can quote it back. */
  raw: string;
  sku: string;
  quantity: number;
}

export interface PasteIssue {
  lineNumber: number;
  raw: string;
  code: PasteIssueCode;
  /** The SKU, when we got that far. */
  sku: string | null;
}

export interface PasteResult {
  lines: PasteLine[];
  issues: PasteIssue[];
}

/** Nobody orders two million of anything by hand; this is a typo guard. */
export const MAX_QUANTITY = 100_000;

/** How many lines one paste may carry, so a stray file cannot become a request. */
export const MAX_LINES = 500;

/** A header row, in the words spreadsheets actually use. */
const HEADERS = new Set([
  "sku",
  "item",
  "code",
  "product",
  "qty",
  "quantity",
  "amount",
  "total",
]);

function isHeader(a: string, b: string | undefined): boolean {
  // Both halves being words a header uses, and neither being a number, is as
  // close to certain as this gets.
  return HEADERS.has(a.toLowerCase()) && b !== undefined && HEADERS.has(b.toLowerCase());
}

/** Split on the separators a paste actually contains, in order of certainty. */
function splitLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  if (line.includes(",")) return line.split(",");
  if (line.includes(";")) return line.split(";");
  // "ABC-123 12" — the last run of digits is the quantity, everything before
  // it the SKU. Only when there is a space to split on at all.
  const match = /^(.*\S)\s+(\d+)$/.exec(line);
  return match ? [match[1]!, match[2]!] : [line];
}

function readQuantity(value: string): number | null {
  // "1,200" and "12 " both mean what they look like; "1.5" of a case does not.
  const text = value.replace(/[\s,]/g, "");
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parse a pasted block.
 *
 * `defaultQuantity` is what a line with only a SKU means. One, normally — a
 * buyer listing SKUs without quantities wants one of each, and refusing the
 * whole paste over it would be pedantic.
 */
export function parsePasteList(
  text: string,
  { defaultQuantity = 1 }: { defaultQuantity?: number } = {},
): PasteResult {
  const lines: PasteLine[] = [];
  const issues: PasteIssue[] = [];
  const seen = new Map<string, number>();

  const rows = text.split(/\r?\n/).slice(0, MAX_LINES);

  rows.forEach((raw, index) => {
    const lineNumber = index + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;

    const parts = splitLine(trimmed).map((part) => part.trim());
    const [first, second] = parts;

    // A header row is skipped rather than reported: a buyer who pasted their
    // spreadsheet's first row did not make a mistake worth a red line.
    if (isHeader(first ?? "", second)) return;

    if (!first) {
      issues.push({ lineNumber, raw: trimmed, code: "no_sku", sku: null });
      return;
    }

    // Quantity first — "12 x ABC-123" and "12, ABC-123" are both common.
    const leadingQuantity = readQuantity(first);
    const sku =
      leadingQuantity !== null && second ? second.replace(/^x\s*/i, "").trim() : first;
    const quantityText = leadingQuantity !== null && second ? first : (second ?? "");

    if (!sku) {
      issues.push({ lineNumber, raw: trimmed, code: "no_sku", sku: null });
      return;
    }

    let quantity: number;
    if (!quantityText) {
      quantity = defaultQuantity;
    } else {
      const parsed = readQuantity(quantityText);
      if (parsed === null) {
        issues.push({
          lineNumber,
          raw: trimmed,
          code: "quantity_not_a_number",
          sku,
        });
        return;
      }
      if (parsed === 0) {
        issues.push({ lineNumber, raw: trimmed, code: "no_quantity", sku });
        return;
      }
      if (parsed > MAX_QUANTITY) {
        issues.push({ lineNumber, raw: trimmed, code: "quantity_too_large", sku });
        return;
      }
      quantity = parsed;
    }

    // The same SKU twice is nearly always two lines of one order, so they are
    // added together and the buyer is told — rather than one silently winning.
    const key = sku.toLowerCase();
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      lines[existingIndex]!.quantity += quantity;
      issues.push({ lineNumber, raw: trimmed, code: "duplicate", sku });
      return;
    }

    seen.set(key, lines.length);
    lines.push({ lineNumber, raw: trimmed, sku, quantity });
  });

  return { lines, issues };
}

/** True when a paste was longer than we will read. */
export function wasTruncated(text: string): boolean {
  return text.split(/\r?\n/).length > MAX_LINES;
}

import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";
import type { ColumnMapping, CsvDocument } from "~/lib/pricing/csv/parse";
import { TEMPLATES, type TemplateKey } from "~/lib/pricing/csv/templates";

/**
 * ✦ The CSV whisperer.
 *
 * Spec §2: "upload *any* messy price sheet — Claude maps columns to SKUs, flags
 * mismatches, and imports. No rigid template required."
 *
 * What it maps is **headers**, not data. The model never sees a price it could
 * change or a SKU it could invent: it is given the column names and a few rows
 * as evidence of what each column contains, and it answers with a header →
 * column mapping the merchant can see and edit before anything is planned. The
 * import itself is the same dry run, the same error report and the same undo
 * window as a file that matched the template on its own.
 */

/** How many rows the model is shown as evidence. Enough to tell a price from a
 *  quantity; few enough that a 50,000-row file costs the same as a 5-row one. */
export const SAMPLE_ROWS = 3;

export type MappingConfidence = "high" | "medium" | "low";

export interface ColumnGuess {
  header: string;
  /** A template column key, or null for "ignore this column". */
  column: string | null;
  confidence: MappingConfidence;
}

export interface MappingAnswer {
  mappings: ColumnGuess[];
  /** One sentence on anything odd. Shown to the merchant, never acted on. */
  notes: string | null;
}

export const CSV_MAPPING_SYSTEM = `You match the columns of a merchant's price spreadsheet to the columns a Shopify wholesale-pricing import expects.

Answer with a single JSON object and nothing else:

{
  "mappings": [ { "header": string, "column": string | null, "confidence": "high" | "medium" | "low" } ],
  "notes": string | null
}

Rules:
- One entry for every header you are given, using the header exactly as it was given to you.
- "column" is one of the target columns you are given, or null when the header does not correspond to any of them. Never invent a column name.
- Never map two headers to the same column. If two could fit, map the better one and leave the other null, and say so in "notes".
- Judge by the column name *and* the sample values. A column called "Price" holding "10, 25, 50" is a quantity break, not a price.
- "high" means the name and the values both fit. "medium" means one of them does. "low" means you are guessing — say why in "notes".
- Required columns matter most. If nothing in the file can fill a required column, say which one in "notes" rather than forcing a bad match.
- Do not translate, reformat or comment on the data itself. You are matching columns, nothing else.`;

export function csvMappingUser(doc: CsvDocument, template: TemplateKey): string {
  const definition = TEMPLATES[template];
  const samples = doc.rows.slice(0, SAMPLE_ROWS);

  const columnLines = definition.columns.map(
    (column) =>
      `- ${column.key}${column.required ? " (required)" : ""} — for example: ${
        column.example || "(may be blank)"
      }`,
  );

  const headerLines = doc.headers.map((header) => {
    const values = samples
      .map((row) => row.cells[header] ?? "")
      .filter((value) => value !== "");
    return `- ${header} — sample values: ${values.length > 0 ? values.join(" | ") : "(all blank)"}`;
  });

  return [
    "Target columns:",
    ...columnLines,
    "",
    `The file's headers, with up to ${SAMPLE_ROWS} sample values each:`,
    ...headerLines,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CONFIDENCES: ReadonlySet<string> = new Set(["high", "medium", "low"]);

/**
 * Narrow the answer against this file and this template.
 *
 * Three ways a mapping can be wrong that the merchant would not spot: a column
 * that does not exist, two headers pointing at one column (silently dropping a
 * column of their file), and a header that was never in the file. All three are
 * refused rather than shown.
 */
export function readMapping(
  value: unknown,
  doc: CsvDocument,
  template: TemplateKey,
): { ok: true; value: MappingAnswer } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "The answer was not a JSON object." };
  if (!Array.isArray(value.mappings)) {
    return { ok: false, error: `"mappings" must be an array.` };
  }

  const columns = new Set(TEMPLATES[template].columns.map((column) => column.key));
  const headers = new Set(doc.headers);
  const usedColumns = new Set<string>();
  const seenHeaders = new Set<string>();
  const mappings: ColumnGuess[] = [];

  for (const raw of value.mappings) {
    if (!isRecord(raw)) return { ok: false, error: "Every mapping must be an object." };

    const header = typeof raw.header === "string" ? raw.header : "";
    if (!headers.has(header)) {
      return {
        ok: false,
        error: `"${header}" is not a header in this file. Use the headers exactly as given.`,
      };
    }
    if (seenHeaders.has(header)) {
      return { ok: false, error: `"${header}" appears twice. One entry per header.` };
    }
    seenHeaders.add(header);

    const column = raw.column === null || raw.column === undefined ? null : raw.column;
    if (column !== null) {
      if (typeof column !== "string" || !columns.has(column)) {
        return {
          ok: false,
          error: `"${String(column)}" is not one of the target columns.`,
        };
      }
      if (usedColumns.has(column)) {
        return {
          ok: false,
          error: `Two headers are mapped to "${column}". Map one and leave the other null.`,
        };
      }
      usedColumns.add(column);
    }

    const confidence =
      typeof raw.confidence === "string" && CONFIDENCES.has(raw.confidence)
        ? (raw.confidence as MappingConfidence)
        : // Not refused: an unlabelled guess is a low-confidence guess, and
          // showing it as such is better than losing the whole mapping.
          "low";

    mappings.push({ header, column, confidence });
  }

  // A header the model skipped is a column of the merchant's file with no
  // answer at all. Filled in as "ignore", so the mapping screen is complete.
  for (const header of doc.headers) {
    if (!seenHeaders.has(header)) {
      mappings.push({ header, column: null, confidence: "low" });
    }
  }

  return {
    ok: true,
    value: {
      mappings,
      notes: typeof value.notes === "string" ? value.notes.trim() || null : null,
    },
  };
}

/** A guess list as the mapping `applyMapping` takes. */
export function toColumnMapping(mappings: readonly ColumnGuess[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const guess of mappings) mapping[guess.header] = guess.column;
  return mapping;
}

/** Ask Claude to match the columns. Never throws; never imports. */
export function mapColumns(
  doc: CsvDocument,
  template: TemplateKey,
  options: { actorId?: string | null } = {},
  deps: AiDeps = {},
): Promise<AiResult<MappingAnswer>> {
  return askForJson<MappingAnswer>(
    {
      feature: "csv_whisperer",
      system: CSV_MAPPING_SYSTEM,
      user: csvMappingUser(doc, template),
      actorId: options.actorId,
      temperature: 0,
      validate: (value) => readMapping(value, doc, template),
    },
    deps,
  );
}

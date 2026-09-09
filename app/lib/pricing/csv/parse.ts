/**
 * A CSV reader, written rather than pulled in.
 *
 * Merchant spreadsheets are the messiest input this app takes: quoted fields
 * with embedded commas and newlines, CRLF from Windows, a byte-order mark from
 * Excel, ragged rows, blank trailing lines. Owning the parser means those cases
 * are ours to test rather than ours to hope about — see parse.test.ts.
 *
 * Follows RFC 4180, plus the two deviations real files always have: a BOM, and
 * rows with fewer or more fields than the header.
 */

export interface CsvRow {
  /** 1-based line number in the original file, for error messages. */
  line: number;
  /** Header name → cell value, trimmed. */
  cells: Record<string, string>;
  /** Fields present on this row, before mapping to headers. */
  raw: string[];
}

export interface CsvDocument {
  headers: string[];
  rows: CsvRow[];
  /** Rows whose field count did not match the header. */
  raggedLines: number[];
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = "CsvParseError";
  }
}

/** Split a CSV document into fields, honouring quotes. */
function tokenize(input: string): { fields: string[][]; lineOf: number[] } {
  const fields: string[][] = [];
  const lineOf: number[] = [];

  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let sawAnyChar = false;

  const endField = () => {
    row.push(field);
    field = "";
  };

  const endRow = () => {
    endField();
    fields.push(row);
    lineOf.push(rowStartLine);
    row = [];
    rowStartLine = line;
    sawAnyChar = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside quotes is a literal quote.
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }

    switch (char) {
      case '"':
        if (field.length > 0) {
          // A quote in the middle of an unquoted field: Excel writes these.
          // Treat it as data rather than refusing the file.
          field += char;
        } else {
          inQuotes = true;
        }
        sawAnyChar = true;
        break;
      case ",":
        endField();
        sawAnyChar = true;
        break;
      case "\r":
        // Swallow; the \n that follows ends the row.
        break;
      case "\n":
        line += 1;
        endRow();
        break;
      default:
        field += char;
        sawAnyChar = true;
        break;
    }
  }

  if (inQuotes) {
    throw new CsvParseError(
      "The file ends inside a quoted value. A quote is probably unclosed.",
      rowStartLine,
    );
  }

  // A trailing newline should not produce an empty final row.
  if (sawAnyChar || field.length > 0 || row.length > 0) endRow();

  return { fields, lineOf };
}

/** Header names are matched loosely: case, spaces and underscores all vary. */
export function normalizeHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function parseCsv(input: string): CsvDocument {
  // Excel writes a byte-order mark, which would otherwise become part of the
  // first header name and break every mapping.
  const text = input.replace(/^\uFEFF/, "");
  if (text.trim() === "") {
    throw new CsvParseError("The file is empty.", 1);
  }

  const { fields, lineOf } = tokenize(text);
  const headerFields = fields[0];
  if (!headerFields) throw new CsvParseError("The file has no header row.", 1);

  const headers = headerFields.map(normalizeHeader);
  const rows: CsvRow[] = [];
  const raggedLines: number[] = [];

  for (let index = 1; index < fields.length; index += 1) {
    const raw = fields[index]!;
    const line = lineOf[index]!;

    // Skip blank lines rather than reporting them as errors; spreadsheets are
    // full of them and a merchant did not mean anything by one.
    if (raw.every((cell) => cell.trim() === "")) continue;

    if (raw.length !== headers.length) raggedLines.push(line);

    const cells: Record<string, string> = {};
    headers.forEach((header, position) => {
      cells[header] = (raw[position] ?? "").trim();
    });

    rows.push({ line, cells, raw });
  }

  return { headers, rows, raggedLines };
}

/** Quote a value for output only when it needs it. */
export function toCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers.map(toCsvValue).join(",")];
  for (const row of rows) lines.push(row.map(toCsvValue).join(","));
  // A trailing newline: some tools drop the last row without one.
  return `${lines.join("\r\n")}\r\n`;
}

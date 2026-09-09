/**
 * VAT number shapes, per country.
 *
 * Two jobs: tell an applicant what their country's number looks like before
 * they get it wrong, and decide whether a number is worth asking VIES about.
 * Pure — the network call lives in vies.server.ts.
 *
 * The list is EU (which VIES covers) plus the GCC countries this app is built
 * for. It is deliberately not exhaustive: an unrecognised country means "we
 * cannot check the shape", which is a note for the reviewer, never a refusal.
 */

export interface VatFormat {
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** What the number looks like, for the field's help text. */
  example: string;
  /** The body of the number, after the country prefix. */
  pattern: RegExp;
  /** VIES can answer for this country. */
  vies: boolean;
}

const eu = (country: string, example: string, pattern: RegExp): VatFormat => ({
  country,
  example,
  pattern,
  vies: true,
});

const gcc = (country: string, example: string, pattern: RegExp): VatFormat => ({
  country,
  example,
  pattern,
  vies: false,
});

export const VAT_FORMATS: Record<string, VatFormat> = {
  AT: eu("AT", "ATU12345678", /^U\d{8}$/),
  BE: eu("BE", "BE0123456789", /^0\d{9}$/),
  BG: eu("BG", "BG123456789", /^\d{9,10}$/),
  CY: eu("CY", "CY12345678L", /^\d{8}[A-Z]$/),
  CZ: eu("CZ", "CZ12345678", /^\d{8,10}$/),
  DE: eu("DE", "DE123456789", /^\d{9}$/),
  DK: eu("DK", "DK12345678", /^\d{8}$/),
  EE: eu("EE", "EE123456789", /^\d{9}$/),
  EL: eu("EL", "EL123456789", /^\d{9}$/),
  ES: eu("ES", "ESX1234567X", /^[A-Z0-9]\d{7}[A-Z0-9]$/),
  FI: eu("FI", "FI12345678", /^\d{8}$/),
  FR: eu("FR", "FRXX123456789", /^[A-Z0-9]{2}\d{9}$/),
  HR: eu("HR", "HR12345678901", /^\d{11}$/),
  HU: eu("HU", "HU12345678", /^\d{8}$/),
  IE: eu("IE", "IE1234567L", /^\d{7}[A-W]([A-I]|W)?$|^\d[A-Z*+]\d{5}[A-W]$/),
  IT: eu("IT", "IT12345678901", /^\d{11}$/),
  LT: eu("LT", "LT123456789", /^(\d{9}|\d{12})$/),
  LU: eu("LU", "LU12345678", /^\d{8}$/),
  LV: eu("LV", "LV12345678901", /^\d{11}$/),
  MT: eu("MT", "MT12345678", /^\d{8}$/),
  NL: eu("NL", "NL123456789B01", /^\d{9}B\d{2}$/),
  PL: eu("PL", "PL1234567890", /^\d{10}$/),
  PT: eu("PT", "PT123456789", /^\d{9}$/),
  RO: eu("RO", "RO1234567890", /^\d{2,10}$/),
  SE: eu("SE", "SE123456789001", /^\d{12}$/),
  SI: eu("SI", "SI12345678", /^\d{8}$/),
  SK: eu("SK", "SK1234567890", /^\d{10}$/),

  // The Gulf. VIES knows nothing about these, so a number here is accepted on
  // its shape and marked unverified rather than sent to a service that would
  // answer "no" about a perfectly valid TRN.
  SA: gcc("SA", "SA300000000000003", /^\d{15}$/),
  AE: gcc("AE", "AE100000000000003", /^\d{15}$/),
  BH: gcc("BH", "BH200000000000002", /^\d{15}$/),
  OM: gcc("OM", "OMOM1100000000", /^[A-Z0-9]{8,12}$/),
  QA: gcc("QA", "QA12345678901", /^\d{5,13}$/),
  KW: gcc("KW", "KW123456789012345", /^\d{9,15}$/),
};

export interface ParsedVat {
  /** The number with spaces, dots and dashes removed, uppercased. */
  normalized: string;
  /** The two-letter prefix, when the number carries one we recognise. */
  country: string | null;
  /** The rest, after the prefix. */
  body: string;
}

export function parseVat(value: string): ParsedVat {
  const normalized = value.toUpperCase().replace(/[\s.\-/]/g, "");
  const prefix = normalized.slice(0, 2);
  const known = Object.prototype.hasOwnProperty.call(VAT_FORMATS, prefix);

  return {
    normalized,
    country: known ? prefix : null,
    body: known ? normalized.slice(2) : normalized,
  };
}

/**
 * Does this look like a VAT number for a country we know?
 *
 * `true` for a number whose country we do not recognise: our table is not the
 * whole world, and refusing an applicant because their country is missing from
 * a hard-coded list would be our bug charged to them.
 */
export function looksLikeVat(value: string): boolean {
  const parsed = parseVat(value);
  if (!parsed.country) return parsed.normalized.length >= 5;

  return VAT_FORMATS[parsed.country]!.pattern.test(parsed.body);
}

/** Can VIES answer about this number? */
export function viesCovers(value: string): boolean {
  const { country } = parseVat(value);
  return country !== null && VAT_FORMATS[country]!.vies;
}

/** The example to show under a VAT field, given the store's country. */
export function vatExampleFor(countryCode: string | null | undefined): string | null {
  if (!countryCode) return null;
  return VAT_FORMATS[countryCode.toUpperCase()]?.example ?? null;
}

import { looksLikeVat, parseVat, viesCovers } from "~/lib/forms/vat-formats";

/**
 * Checking a VAT number against the EU's VIES service.
 *
 * The rule that shapes everything here: **a third-party outage must never
 * block an applicant.** VIES is famously unreliable — individual member states
 * go offline for hours — and a wholesale buyer who cannot apply because
 * Belgium's tax server is down is a customer lost to someone else's downtime.
 *
 * So the only two outcomes that stop anything are "the service answered, and
 * said no". Everything else — timeout, 500, connection refused, a country VIES
 * does not cover, a format we do not recognise — is `unverified`, which is
 * accepted with a flag for the reviewer. Unverified is not invalid.
 */

/** An applicant is waiting on this, so it is short. */
export const VIES_TIMEOUT_MS = 5000;
/** One retry, per the app's standing rule for external calls. */
export const VIES_RETRIES = 1;

const VIES_ENDPOINT = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms";

export type VatStatus = "valid" | "invalid" | "unverified";

export type VatNote =
  /** The shape does not match the country's pattern. */
  | "format"
  /** VIES does not answer for this country — the Gulf, mostly. */
  | "outside_eu"
  /** Timed out, refused, or answered with an error. */
  | "vies_unreachable";

export interface VatCheck {
  status: VatStatus;
  note: VatNote | null;
  /** The registered name VIES returned, when it returned one. */
  name?: string | null;
  /** The normalised number, which is what gets stored. */
  normalized: string;
}

export interface CheckVatOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

async function callVies(
  country: string,
  number: string,
  options: Required<Pick<CheckVatOptions, "fetchImpl" | "timeoutMs">>,
): Promise<{ valid: boolean; name?: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetchImpl(
      `${VIES_ENDPOINT}/${country}/vat/${number}`,
      { signal: controller.signal, headers: { accept: "application/json" } },
    );

    if (!response.ok) return null;

    const body = (await response.json()) as {
      isValid?: boolean;
      valid?: boolean;
      name?: string | null;
      userError?: string;
    };

    // VIES reports a member state being down as a userError alongside a 200,
    // which is not the same as "this number is not valid".
    if (body.userError && body.userError !== "VALID" && body.userError !== "INVALID") {
      return null;
    }

    const valid = body.isValid ?? body.valid;
    if (typeof valid !== "boolean") return null;

    return { valid, name: body.name ?? null };
  } catch {
    // Timeout, DNS, TLS, a refused connection, a body that is not JSON. All of
    // them mean the same thing to an applicant: we could not check.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkVat(
  value: string,
  options: CheckVatOptions = {},
): Promise<VatCheck> {
  const parsed = parseVat(value);
  const normalized = parsed.normalized;

  if (!looksLikeVat(value)) {
    return { status: "unverified", note: "format", normalized };
  }

  if (!viesCovers(value)) {
    // A Saudi TRN is a real VAT number that VIES would answer "no" about.
    // Asking it would turn a valid registration into an invalid one.
    return { status: "unverified", note: "outside_eu", normalized };
  }

  const settings = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? VIES_TIMEOUT_MS,
  };
  const attempts = (options.retries ?? VIES_RETRIES) + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await callVies(parsed.country!, parsed.body, settings);
    if (result) {
      return {
        status: result.valid ? "valid" : "invalid",
        note: null,
        name: result.name ?? null,
        normalized,
      };
    }
  }

  return { status: "unverified", note: "vies_unreachable", normalized };
}

/** The database enum for a check result. */
export function toDbStatus(check: VatCheck): "VALID" | "INVALID" | "UNVERIFIED" {
  if (check.status === "valid") return "VALID";
  if (check.status === "invalid") return "INVALID";
  return "UNVERIFIED";
}

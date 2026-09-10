import {
  askForText,
  type AiDeps,
  type AiResult,
  type AskOptions,
} from "~/lib/ai/run.server";

/**
 * Asking for JSON, and refusing to trust it.
 *
 * Almost everything Mannon asks Claude for is structured — a pricing rule, a
 * segment, a set of parsed order lines. The model is good at JSON and still
 * gets it wrong sometimes: a trailing comma, a fenced code block, a field
 * invented on the spot.
 *
 * So nothing here believes the answer. The caller supplies a validator, and a
 * value that does not pass it is **not returned** — it gets one repair attempt
 * with the error handed back, and then the manual path. A half-valid rule
 * reaching a merchant's pricing is precisely what the invariants forbid.
 */

/** What a caller says about a parsed value. */
export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export interface JsonOptions<T> extends AskOptions {
  /**
   * Narrow and check the parsed JSON.
   *
   * Returns the typed value or a sentence naming what is wrong — that sentence
   * is what the repair attempt is given, so it should say what a correct answer
   * would look like.
   */
  validate: (value: unknown) => Validated<T>;
}

/**
 * Pull JSON out of an answer that may be wrapped.
 *
 * Models fence JSON in ``` blocks and sometimes add a sentence before it. Both
 * are recoverable without guessing at the content, so they are recovered rather
 * than counted as a failure the merchant pays for.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  // A leading sentence, then an object or an array. Taken from the first
  // opening brace to the last matching close, which is unambiguous for the
  // shapes this app asks for.
  const start = trimmed.search(/[[{]/);
  if (start > 0) {
    const opener = trimmed[start];
    const closer = opener === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(closer);
    if (end > start) return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

/**
 * Ask for JSON, validate it, and repair once.
 *
 * At most two model calls: the ask, and one repair carrying the parse or
 * validation error. Anything still wrong after that is `invalid_output`, and
 * the caller uses its manual path — which every AI feature in this app has,
 * because that is the only way the product works with the key unset.
 */
export async function askForJson<T>(
  options: JsonOptions<T>,
  deps: AiDeps = {},
): Promise<AiResult<T>> {
  const { validate, ...ask } = options;

  const first = await askForText(ask, deps);
  if (!first.ok) return first;

  const parsed = readAndValidate(first.value, validate);
  if (parsed.ok) return { ...first, value: parsed.value };

  const repair = await askForText(
    {
      ...ask,
      user: [
        ask.user,
        "",
        "Your previous answer could not be used:",
        parsed.error,
        "",
        "Reply with the corrected JSON and nothing else — no explanation, no code fence.",
      ].join("\n"),
    },
    deps,
  );
  if (!repair.ok) return repair;

  const second = readAndValidate(repair.value, validate);
  if (second.ok) return { ...repair, value: second.value };

  return {
    ok: false,
    reason: "invalid_output",
    detail: `The model's answer did not validate, twice: ${second.error}`,
    latencyMs: first.latencyMs + repair.latencyMs,
    attempts: first.attempts + repair.attempts,
  };
}

function readAndValidate<T>(
  text: string,
  validate: (value: unknown) => Validated<T>,
): Validated<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (error) {
    return {
      ok: false,
      error: `It was not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return validate(parsed);
}

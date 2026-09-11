import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";
import { placeholdersIn } from "~/lib/i18n/strings.server";

/**
 * ✦ Fill the strings a language is missing.
 *
 * Checklist §8: *"✦ Fill missing with AI per language, human-review flag per
 * string"*. Both halves matter and the second is the one that makes the first
 * safe: nothing this writes goes to a buyer unmarked. Every filled string
 * arrives as `aiFilled` **and** `needsReview`, the table shows both, and a
 * merchant can accept or rewrite each one.
 *
 * The model translates and does nothing else. It is given the English, the
 * target language, and the placeholders the string must contain — and a reply
 * whose placeholders differ from the source is thrown away rather than shown,
 * because `{{days}}` missing from a translation is a buyer reading "your quote
 * expires in days" and nobody finding out.
 */

export const TRANSLATE_SYSTEM = `You translate short interface strings for a Shopify wholesale app. The reader is a trade buyer: a shop owner buying stock, not a consumer.

Reply with a single JSON object and nothing else:

{ "translations": { "<key>": "<translation>", … } }

Rules:
- Translate the meaning, not the words. These are buttons, labels, errors and short messages; they should read as a native speaker would write them, not as English rearranged.
- **Placeholders are copied exactly.** A string containing {{count}} or {{days}} must contain the same placeholders, spelled the same way. Never add one, never drop one, never rename one. The app fills them in.
- Keep it about as short as the English. These sit in buttons and table cells.
- Never add a figure, a price, a date or a quantity that is not already a placeholder.
- Keep any leading ✦ exactly where it is: it marks what Claude wrote, and a merchant relies on it.
- Return every key you were given, and no others.`;

export interface TranslateInput {
  language: string;
  strings: { key: string; english: string }[];
  /** The merchant's own writing, so the wording sounds like their shop. */
  voiceSamples?: { label: string; body: string }[];
}

export function translateUser(input: TranslateInput): string {
  return [
    `Target language: ${input.language}`,
    "",
    "Strings to translate, as key then English:",
    ...input.strings.map((one) => `${one.key}\n  ${one.english}`),
    ...(input.voiceSamples && input.voiceSamples.length > 0
      ? [
          "",
          "How this merchant writes to their buyers. Match their register — how formal they are, how warm, how brief. Never copy their content, and never let it change what a string means.",
          ...input.voiceSamples.map((one) => `--- ${one.label} ---\n${one.body}`),
        ]
      : []),
  ].join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read a batch back, keeping only what is safe to show.
 *
 * Deliberately lenient about *missing* keys and strict about *wrong* ones: a
 * model that returns nine of ten leaves the tenth for a person, which is the
 * honest outcome. One whose placeholders do not match has produced a string
 * that would break in front of a buyer, and that one is dropped.
 */
export function readTranslations(asked: { key: string; english: string }[]): (
  value: unknown,
) =>
  | { ok: true; value: Record<string, string> }
  | {
      ok: false;
      error: string;
    } {
  const wanted = new Map(asked.map((one) => [one.key, one.english]));

  return (value) => {
    if (!isRecord(value) || !isRecord(value.translations)) {
      return { ok: false, error: 'Reply with { "translations": { key: string } }.' };
    }

    const kept: Record<string, string> = {};
    const broken: string[] = [];

    for (const [key, translated] of Object.entries(value.translations)) {
      const english = wanted.get(key);
      if (english === undefined) continue; // A key nobody asked for.
      if (typeof translated !== "string" || translated.trim() === "") continue;

      const source = placeholdersIn(english);
      const theirs = placeholdersIn(translated);
      if (
        source.length !== theirs.length ||
        source.some((one, at) => one !== theirs[at])
      ) {
        broken.push(key);
        continue;
      }
      kept[key] = translated.trim();
    }

    if (Object.keys(kept).length === 0) {
      return {
        ok: false,
        error:
          broken.length > 0
            ? `These translations changed their placeholders: ${broken.join(", ")}. Copy {{…}} exactly as it appears in the English.`
            : "No usable translations came back.",
      };
    }

    return { ok: true, value: kept };
  };
}

/** One batch. Never writes, never throws. */
export function translateStrings(
  input: TranslateInput,
  deps: AiDeps = {},
): Promise<AiResult<Record<string, string>>> {
  return askForJson<Record<string, string>>(
    {
      feature: "translate_strings",
      system: TRANSLATE_SYSTEM,
      user: translateUser(input),
      validate: readTranslations(input.strings),
      maxTokens: 4_000,
    },
    deps,
  );
}

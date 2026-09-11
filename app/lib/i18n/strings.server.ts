import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { SUPPORTED_LOCALES, type Locale } from "~/i18n/config";
import ar from "~/i18n/locales/ar.json";
import en from "~/i18n/locales/en.json";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * The storefront strings a merchant may rewrite.
 *
 * Checklist §8: *"every storefront string editable, multi-language"*.
 *
 * **Which strings, and which deliberately not.** The theme blocks' own
 * headings and intros are `block.settings` in the liquid — already editable in
 * the theme editor, where a merchant expects to find them. Taking those over
 * would mean two places to edit one sentence. What is *not* editable anywhere
 * is everything this app renders: the registration form, the Buyer Agent
 * widget, the quote a buyer accepts, the approval and rejection emails, and
 * the message at checkout when an order misses a minimum.
 *
 * Derived from the catalogue rather than listed. A hand-kept list of editable
 * keys is the registration step this repo has now forgotten three times
 * (`CATALOG_ROOTS`, `qa:capture`'s file list, the action picker), and here
 * forgetting one means a merchant is told a string is not theirs to change
 * when it is the only one a buyer reads.
 */

/**
 * The paths a buyer reads. Everything under them is editable.
 *
 * Paths, not roots. The first version of this took whole roots — `forms`,
 * `quotes`, `limit`, `approval`, `agent` — and offered a merchant 534 strings
 * of which about forty ever reach a buyer. `limit.*` is the Plans page's
 * allowance copy; all of `approval.*` is the merchant's own criteria builder;
 * most of `forms.*` and `quotes.*` is the admin. Editing any of them changed
 * nothing anywhere, which is a page of controls that cannot act.
 *
 * `tests/unit/buyer-strings.test.ts` reads the buyer-facing source files and
 * fails if any key they translate is missing from this set — so this is
 * checked against the surfaces rather than believed.
 */
export const BUYER_FACING_PATHS = [
  // The registration form a buyer fills in.
  "forms.public",
  // The quote page a buyer accepts on.
  "quotes.public",
  // The two things the Buyer Agent says in its own voice rather than the
  // model's — a refusal and an off-limits topic.
  "agent.scripted",
  // The message at checkout when an order misses a minimum. Not rendered by
  // React at all: it is published to a metafield and read by the Function.
  "checkout",
] as const;

export interface CatalogueString {
  key: string;
  /** What the app ships, in this locale. */
  shipped: string;
  /** What the merchant has made it, if anything. */
  value: string | null;
  aiFilled: boolean;
  needsReview: boolean;
}

/**
 * Plural categories Arabic has and English does not, under the same paths.
 *
 * `quotes.public` has no plurals today; `quotes.expiresIn_few` is admin copy.
 * This exists so that the day one appears, it is editable with the rest of
 * its own string rather than silently not.
 */
function arabicOnlyKeys(): string[] {
  const found: string[] = [];

  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") {
      found.push(path);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [part, child] of Object.entries(node)) {
      walk(child, path === "" ? part : `${path}.${part}`);
    }
  };

  for (const path of BUYER_FACING_PATHS) {
    let node: unknown = ar;
    for (const part of path.split(".")) {
      if (typeof node !== "object" || node === null) break;
      node = (node as Record<string, unknown>)[part];
    }
    if (node !== undefined) walk(node, path);
  }

  return found;
}

/** Every editable key, flattened out of the shipped catalogue. */
export function editableKeys(): string[] {
  const keys: string[] = [];

  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") {
      keys.push(path);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [part, child] of Object.entries(node)) {
      walk(child, path === "" ? part : `${path}.${part}`);
    }
  };

  for (const path of BUYER_FACING_PATHS) {
    let node: unknown = en;
    for (const part of path.split(".")) {
      node = (node as Record<string, unknown>)[part];
    }
    walk(node, path);
  }

  // Arabic pluralises into six categories where English has two, and the walk
  // above only sees English's. A merchant who rewrote `expiresIn_one` and
  // `_other` believed the string was theirs while an Arabic buyer whose quote
  // expires in three days read Mannon's `_few`.
  const known = new Set(keys);
  for (const key of arabicOnlyKeys()) {
    if (!known.has(key)) keys.push(key);
  }

  return keys.sort();
}

/** The shipped string for a key, or null when the catalogue has no such key. */
export function shippedString(key: string, locale: Locale): string | null {
  // Read from the `en` module for structure and from the locale's own file for
  // the value; both are bundled, so this is a lookup rather than a read.
  const catalogue = CATALOGUES[locale];
  let node: unknown = catalogue;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

const CATALOGUES: Record<Locale, unknown> = { en, ar };

/* -------------------------------------------------------------------------- */

/**
 * Every override this shop has, as a flat map.
 *
 * The shape i18next's `addResourceBundle` wants, and the shape the render
 * path wants — one call, so no surface can read half of them.
 */
export async function overridesFor(locale: Locale): Promise<Record<string, string>> {
  // Outside a shop scope there are no overrides, and that is not an error: the
  // login page and the error boundary both translate without a tenant.
  if (!shopScope.get()) return {};

  // **Not** the ones ✦ suggested and nobody has read.
  //
  // `translations.fillPromise` says, above the button: "nothing reaches a
  // buyer as your words until you accept it", and the checklist says "never
  // auto-publish a language the merchant hasn't seen". Without this clause a
  // suggestion was live on the very next render, under a badge reading
  // "Claude suggested this" — a draft that publishes itself is not a draft.
  const rows = await db.storefrontString.findMany({
    where: { locale, needsReview: false },
    select: { key: true, value: true },
  });
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export interface StringsPage {
  rows: CatalogueString[];
  total: number;
  page: number;
  pageSize: number;
}

export const STRINGS_PAGE_SIZE = 25;

/** One page of the table, filtered the way the merchant asked. */
export async function listStrings(options: {
  locale: Locale;
  search?: string;
  /**
   * Only the ones the merchant has not written themselves.
   *
   * This used to be "only the ones this locale has no translation for at all",
   * which could never match a row: both catalogues ship complete and
   * `tests/unit/i18n-catalogs.test.ts` keeps them that way, so `shipped` was
   * always truthy and the filter always produced the empty state. It now means
   * what the ✦ panel beside it counts.
   */
  unwrittenOnly?: boolean;
  /** Only the ones ✦ wrote and nobody has confirmed. */
  reviewOnly?: boolean;
  page?: number;
}): Promise<StringsPage> {
  shopScope.require("listStrings");
  const page = Math.max(1, options.page ?? 1);
  const search = (options.search ?? "").trim().toLowerCase();

  const rows = await db.storefrontString.findMany({ where: { locale: options.locale } });
  const byKey = new Map(rows.map((row) => [row.key, row]));

  const all = editableKeys().flatMap((key): CatalogueString[] => {
    const shipped = shippedString(key, options.locale);
    const override = byKey.get(key);

    // A key the catalogue does not carry in this locale is a key a merchant
    // cannot usefully be shown as "shipped as" — but it is exactly what
    // "missing" means, so it stays in the list with an empty shipped value.
    const row: CatalogueString = {
      key,
      shipped: shipped ?? "",
      value: override?.value ?? null,
      aiFilled: override?.aiFilled ?? false,
      needsReview: override?.needsReview ?? false,
    };

    if (options.unwrittenOnly && row.value !== null) return [];
    if (options.reviewOnly && !row.needsReview) return [];
    if (
      search &&
      !key.toLowerCase().includes(search) &&
      !row.shipped.toLowerCase().includes(search) &&
      !(row.value ?? "").toLowerCase().includes(search)
    ) {
      return [];
    }
    return [row];
  });

  return {
    rows: all.slice((page - 1) * STRINGS_PAGE_SIZE, page * STRINGS_PAGE_SIZE),
    total: all.length,
    page,
    pageSize: STRINGS_PAGE_SIZE,
  };
}

/* -------------------------------------------------------------------------- */

export class StringInvalid extends Error {
  constructor(readonly code: "unknownKey" | "unknownLocale" | "placeholders") {
    super(`string rejected: ${code}`);
    this.name = "StringInvalid";
  }
}

/** `{{name}}` and the like, in the order they appear. */
export const placeholdersIn = (text: string): string[] =>
  [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]!).sort();

/** Two placeholder lists, same tags in the same order. */
export const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((one, index) => one === b[index]);

/**
 * Save one string, or clear it back to what the app ships.
 *
 * The placeholder check is the load-bearing one: `{{days}}` in the shipped
 * string and nothing in the merchant's means a buyer reads "your quote expires
 * in days". i18next would not complain — it has nothing to interpolate — and
 * the merchant would not find out until somebody told them.
 */
export async function saveString(
  input: { key: string; locale: string; value: string; needsReview?: boolean },
  { actor }: { actor: AuditActor },
): Promise<void> {
  const shop = shopScope.require("saveString");

  if (!(SUPPORTED_LOCALES as readonly string[]).includes(input.locale)) {
    throw new StringInvalid("unknownLocale");
  }
  const locale = input.locale as Locale;
  if (!editableKeys().includes(input.key)) throw new StringInvalid("unknownKey");

  const value = input.value.trim();
  const shipped =
    shippedString(input.key, locale) ?? shippedString(input.key, "en") ?? "";

  if (value !== "" && !sameSet(placeholdersIn(value), placeholdersIn(shipped))) {
    throw new StringInvalid("placeholders");
  }

  if (value === "") {
    // Cleared, not blanked: the app's own words come back rather than a buyer
    // reading nothing at all.
    const existing = await db.storefrontString.findFirst({
      where: { key: input.key, locale },
    });
    if (!existing) return;
    await db.storefrontString.delete({ where: { id: existing.id } });
  } else {
    await db.storefrontString.upsert({
      where: { shop_key_locale: { shop, key: input.key, locale } },
      create: {
        ...tenant(),
        key: input.key,
        locale,
        value,
        aiFilled: false,
        needsReview: input.needsReview ?? false,
        updatedBy: actor.id ?? null,
      },
      // A person editing an ✦ fill has reviewed it by definition.
      update: {
        value,
        aiFilled: false,
        needsReview: input.needsReview ?? false,
        updatedBy: actor.id ?? null,
      },
    });
  }

  await recordAudit({
    actor,
    action: value === "" ? "storefront_string.cleared" : "storefront_string.saved",
    summary:
      value === ""
        ? `Restored the shipped wording for “${input.key}” in ${locale}.`
        : `Changed the wording of “${input.key}” in ${locale}.`,
    subject: { type: "Shop", id: shop },
    // The key and the language, never the words: an audit summary is read in a
    // list, and the words are on the page one click away.
    metadata: { key: input.key, locale },
  });
}

/** Mark an ✦ fill as read and accepted, without changing a word of it. */
export async function acceptString(
  input: { key: string; locale: string },
  { actor }: { actor: AuditActor },
): Promise<void> {
  const shop = shopScope.require("acceptString");
  const row = await db.storefrontString.findFirst({
    where: { key: input.key, locale: input.locale },
  });
  if (!row || !row.needsReview) return;

  await db.storefrontString.update({
    where: { id: row.id },
    data: { needsReview: false, updatedBy: actor.id ?? null },
  });

  await recordAudit({
    actor,
    action: "storefront_string.accepted",
    summary: `Accepted the suggested wording for “${input.key}” in ${input.locale}.`,
    subject: { type: "Shop", id: shop },
    metadata: { key: input.key, locale: input.locale },
    // This is the moment Claude's words become something a buyer reads, so
    // this is the entry that carries the approver. `recordAudit` refuses an
    // `aiAssisted` entry with no approval, which is the point of both.
    ...(row.aiFilled && actor.id
      ? { aiAssisted: true, approval: { byId: actor.id } }
      : {}),
  });
}

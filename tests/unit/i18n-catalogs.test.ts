import { describe, expect, it } from "vitest";

import { detectLocale, getFixedT } from "~/i18n.server";
import {
  DEFAULT_LOCALE,
  dirFor,
  isSupportedLocale,
  normalizeLocale,
  SUPPORTED_LOCALES,
} from "~/i18n/config";
import ar from "~/i18n/locales/ar.json";
import en from "~/i18n/locales/en.json";

type Json = { [key: string]: string | Json };

function flatten(node: Json, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

const EN = flatten(en as Json);
const AR = flatten(ar as Json);

/** {{name}} placeholders a string expects, sorted. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).sort();
}

describe("translation catalogs", () => {
  it("covers every English key in Arabic", () => {
    expect(Object.keys(EN).filter((key) => !(key in AR))).toEqual([]);
  });

  it("has no Arabic keys that English does not define", () => {
    // English is the source of truth; a stray Arabic key is a rename that only
    // got applied on one side.
    expect(Object.keys(AR).filter((key) => !(key in EN))).toEqual([]);
  });

  it("has no blank strings in either catalog", () => {
    const blank = [...Object.entries(EN), ...Object.entries(AR)]
      .filter(([, value]) => value.trim() === "")
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });

  /**
   * A translation that drops or renames a placeholder renders "{{phase}}"
   * literally to the merchant. Cheap to check, impossible to spot by eye in a
   * script you cannot read.
   */
  it("keeps the same interpolation placeholders in every language", () => {
    const mismatched = Object.keys(EN).filter(
      (key) => placeholders(EN[key]!).join() !== placeholders(AR[key]!).join(),
    );
    expect(mismatched).toEqual([]);
  });

  it("does not leave an English string sitting in the Arabic catalog", () => {
    // Placeholders and the .myshopify.com domain are legitimately identical.
    const allowed = new Set(["install.shopPlaceholder"]);
    const untranslated = Object.keys(EN).filter(
      (key) => !allowed.has(key) && EN[key] === AR[key],
    );
    expect(untranslated).toEqual([]);
  });
});

describe("locale configuration", () => {
  it("ships English and Arabic", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "ar"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("mirrors only Arabic", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });

  it("normalises regional tags to the shipped language", () => {
    expect(normalizeLocale("ar-SA")).toBe("ar");
    expect(normalizeLocale("en_GB")).toBe("en");
    expect(normalizeLocale("AR")).toBe("ar");
    expect(normalizeLocale("fr-FR")).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
    expect(normalizeLocale("")).toBeUndefined();
  });

  it("rejects unsupported locales", () => {
    expect(isSupportedLocale("ar")).toBe(true);
    expect(isSupportedLocale("de")).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });
});

describe("locale detection", () => {
  const req = (url: string, headers: HeadersInit = {}) => new Request(url, { headers });

  it("prefers the locale Shopify puts on the embedded request", () => {
    expect(detectLocale(req("https://mannon.test/app?locale=ar-SA"))).toBe("ar");
  });

  it("lets the query param win over Accept-Language", () => {
    expect(
      detectLocale(
        req("https://mannon.test/app?locale=ar", { "accept-language": "en-GB,en" }),
      ),
    ).toBe("ar");
  });

  it("falls back to Accept-Language on unembedded requests", () => {
    expect(
      detectLocale(req("https://mannon.test/", { "accept-language": "ar-EG,ar;q=0.9" })),
    ).toBe("ar");
  });

  it("skips unsupported languages in Accept-Language rather than giving up", () => {
    expect(
      detectLocale(
        req("https://mannon.test/", { "accept-language": "fr-FR,fr;q=0.9,ar;q=0.8" }),
      ),
    ).toBe("ar");
  });

  it("falls back to English for an unsupported or missing locale", () => {
    expect(detectLocale(req("https://mannon.test/app?locale=de"))).toBe("en");
    expect(detectLocale(req("https://mannon.test/"))).toBe("en");
  });
});

describe("server-side translation", () => {
  it("translates in the requested language", async () => {
    const t = await getFixedT("ar");
    expect(t("nav.pricing")).toBe("التسعير");
  });

  it("interpolates without HTML-escaping the value", async () => {
    const t = await getFixedT("en");
    expect(t("scaffold.body", { feature: "Pricing", phase: "1.3" })).toContain(
      "Pricing feature set lands in phase 1.3",
    );
  });
});

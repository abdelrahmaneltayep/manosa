import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { getFixedT } from "~/i18n.server";
import { translateStrings, translateUser } from "~/lib/ai/prompts/translate.server";
import {
  exportStrings,
  fillMissing,
  ImportInvalid,
  importStrings,
  unwrittenIn,
} from "~/lib/i18n/fill.server";
import {
  editableKeys,
  listStrings,
  placeholdersIn,
  saveString,
  shippedString,
  StringInvalid,
} from "~/lib/i18n/strings.server";
import { saveSettings } from "~/lib/settings/settings.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * Storefront translations.
 *
 * The question worth asking: does a word a merchant types actually reach the
 * buyer? Everything else here — the table, the filters, the fill — is in
 * service of that one thing, and a table that saves a row nothing renders is
 * the shape this repo keeps finding.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const ACTOR = { type: "STAFF" as const, id: "staff-1" };

/**
 * A buyer-facing key whose shipped English carries no `{{tag}}`.
 *
 * Found rather than named: a test that hard-codes a key stops testing the day
 * that key is reworded, and one that picks the first buyer-facing key picks
 * `forms.public.fileHelp`, whose `{{megabytes}}` every save is checked against.
 */
const plainKey = () =>
  editableKeys().find(
    (one) =>
      one.startsWith("forms.public.") &&
      placeholdersIn(shippedString(one, "en") ?? "").length === 0,
  )!;

function reply(text: string) {
  return {
    id: "msg_01tr",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 90, output_tokens: 60, cache_read_input_tokens: 0 },
  };
}

const stub = (fn: (body: unknown) => Promise<unknown>) => ({ create: fn }) as never;
const once = (text: string) => stub(async () => reply(text));

async function installShop(shop: string) {
  await shopScope.run(shop, async () => {
    await db.shop.create({
      data: { ...tenant(), planKey: "agentic", billingStatus: "ACTIVE" },
    });
  });
}

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
});

/* -------------------------------------------------------------------------- */

describe("the editable set", () => {
  it("is derived from the catalogue, not a list somebody keeps up to date", () => {
    const keys = editableKeys();

    // The paths a buyer reads, and all of them. A hand-kept list is the
    // registration step this repo has forgotten three times, and forgetting a
    // key here means telling a merchant a string is not theirs to change.
    expect(keys.some((key) => key.startsWith("forms.public."))).toBe(true);
    expect(keys.some((key) => key.startsWith("quotes.public."))).toBe(true);
    expect(keys.some((key) => key.startsWith("agent.scripted."))).toBe(true);
    // The checkout message: no React page renders it, so nothing that walks
    // the components would find it, and the Limits page links a merchant here.
    expect(keys).toContain("checkout.below_minimum_subtotal");

    // Admin copy is not a merchant's to rewrite: nothing renders it to a
    // buyer, and 6.6 first shipped offering 534 strings of which about forty
    // ever reached one. `limit.*` is the Plans page's allowance copy;
    // `approval.*` is the merchant's own criteria builder.
    for (const admin of [
      "settings.",
      "analytics.",
      "limit.",
      "approval.",
      "forms.list.",
    ]) {
      expect(
        keys.filter((key) => key.startsWith(admin)),
        admin,
      ).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("a merchant's own wording", () => {
  it("reaches the buyer, which is the whole point", async () => {
    await installShop(ALPHA);
    const key = plainKey();

    await inAlpha(async () => {
      const before = await getFixedT("en");
      const shipped = before(key);

      await saveString(
        { key, locale: "en", value: "Our own words here." },
        {
          actor: ACTOR,
        },
      );

      // A table that stores a row nothing renders is a table that lies. The
      // override is applied where instances are built, so there is no surface
      // that translates without it.
      const after = await getFixedT("en");
      expect(after(key)).toBe("Our own words here.");
      expect(after(key)).not.toBe(shipped);
    });
  });

  it("is one shop's wording and never another's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const key = plainKey();

    await inAlpha(() =>
      saveString({ key, locale: "en", value: "Alpha's words." }, { actor: ACTOR }),
    );

    await inBeta(async () => {
      const t = await getFixedT("en");
      expect(t(key)).not.toBe("Alpha's words.");
      expect(await listStrings({ locale: "en" })).toMatchObject({
        total: expect.any(Number),
      });
      expect(
        (await listStrings({ locale: "en" })).rows.every((row) => row.value === null),
      ).toBe(true);
    });
  });

  it("comes back to Mannon's words when cleared, not to nothing", async () => {
    await installShop(ALPHA);
    const key = plainKey();

    await inAlpha(async () => {
      const shipped = (await getFixedT("en"))(key);
      await saveString({ key, locale: "en", value: "Ours." }, { actor: ACTOR });
      await saveString({ key, locale: "en", value: "  " }, { actor: ACTOR });

      // Blanking a string would leave a buyer reading an empty button.
      expect((await getFixedT("en"))(key)).toBe(shipped);
      expect(await db.storefrontString.count()).toBe(0);
    });
  });

  it("refuses wording that drops a placeholder", async () => {
    await installShop(ALPHA);

    // A real key whose shipped English carries a `{{tag}}` — found, not
    // assumed, so this test cannot quietly stop testing anything.
    const key = editableKeys().find(
      (one) => placeholdersIn(shippedString(one, "en") ?? "").length > 0,
    )!;
    expect(key).toBeDefined();

    await inAlpha(async () => {
      const tags = placeholdersIn(shippedString(key, "en")!);

      // `{{days}}` missing means a buyer reads "your quote expires in days",
      // i18next has nothing to interpolate and nothing to complain about, and
      // the merchant finds out when somebody tells them.
      await expect(
        saveString({ key, locale: "en", value: "No tags at all." }, { actor: ACTOR }),
      ).rejects.toBeInstanceOf(StringInvalid);

      // The same wording with the tags kept is fine.
      await saveString(
        {
          key,
          locale: "en",
          value: `Kept ${tags.map((tag) => `{{${tag}}}`).join(" ")}.`,
        },
        { actor: ACTOR },
      );
      expect(await db.storefrontString.count()).toBe(1);
    });
  });

  it("records the key and the language, never the words", async () => {
    await installShop(ALPHA);
    const key = plainKey();

    await inAlpha(async () => {
      await saveString(
        { key, locale: "en", value: "Something a buyer will read." },
        { actor: ACTOR },
      );

      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "storefront_string.saved" },
      });
      expect(entry.summary).toContain(key);
      expect(entry.summary).not.toContain("Something a buyer will read");
      expect(JSON.stringify(entry.metadata)).not.toContain("Something a buyer");
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("✦ suggesting wording", () => {
  it("offers the strings the merchant has not written, untranslated ones first", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      // Every editable key starts unwritten: the app's wording is Mannon's,
      // and a shop with a house style has five hundred strings that sound like
      // somebody else. A "fill what is missing" button would have had nothing
      // to do on any store, because both catalogues ship complete.
      expect((await unwrittenIn("ar")).length).toBe(editableKeys().length);

      const key = editableKeys()[0]!;
      await saveString({ key, locale: "ar", value: "كلماتنا." }, { actor: ACTOR });
      expect(await unwrittenIn("ar")).not.toContain(key);
    });
  });

  it("marks everything it writes as a suggestion, and touches nothing else", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const [first, second] = editableKeys();
      await saveString(
        { key: first!, locale: "ar", value: "كلماتي أنا." },
        {
          actor: ACTOR,
        },
      );

      const result = await fillMissing(
        { locale: "ar", actor: ACTOR },
        {
          messages: once(
            JSON.stringify({
              translations: { [first!]: "اقتراح للأولى", [second!]: "اقتراح للثانية" },
            }),
          ),
        },
      );

      expect(result.failure).toBeNull();
      expect(result.filled).toBeGreaterThan(0);

      // The merchant's own wording is never overwritten by a suggestion.
      const mine = await db.storefrontString.findFirstOrThrow({
        where: { key: first!, locale: "ar" },
      });
      expect(mine.value).toBe("كلماتي أنا.");
      expect(mine.aiFilled).toBe(false);

      // And everything it did write says who wrote it, twice.
      const suggested = await db.storefrontString.findFirstOrThrow({
        where: { key: second!, locale: "ar" },
      });
      expect(suggested.aiFilled).toBe(true);
      expect(suggested.needsReview).toBe(true);
    });
  });

  it("throws away a translation that changed its placeholders", async () => {
    await installShop(ALPHA);
    const asked = [{ key: "quotes.expiresIn", english: "Expires in {{days}} days." }];

    await inAlpha(async () => {
      // `{{days}}` missing means a buyer reads a sentence with a hole in it,
      // and i18next has nothing to interpolate and nothing to complain about.
      const bad = await translateStrings(
        { language: "Arabic", strings: asked },
        {
          messages: once(
            JSON.stringify({ translations: { "quotes.expiresIn": "تنتهي قريباً." } }),
          ),
        },
      );
      expect(bad.ok).toBe(false);

      const good = await translateStrings(
        { language: "Arabic", strings: asked },
        {
          messages: once(
            JSON.stringify({
              translations: { "quotes.expiresIn": "تنتهي خلال {{days}} أيام." },
            }),
          ),
        },
      );
      expect(good.ok).toBe(true);
      if (good.ok) expect(good.value["quotes.expiresIn"]).toContain("{{days}}");
    });
  });

  it("carries the merchant's own writing into the prompt", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const user = translateUser({
        language: "Arabic",
        strings: [{ key: "forms.submit", english: "Apply" }],
        voiceSamples: [{ label: "How I welcome a buyer", body: "Lovely to have you." }],
      });

      // This is what makes the samples earn their place beyond the approval
      // emails, and what makes the button worth pressing at all.
      expect(user).toContain("Lovely to have you.");
      expect(user).toContain("Never copy their content");
    });
  });

  it("is refused on a plan that does not include it", async () => {
    await shopScope.run(ALPHA, async () => {
      await db.shop.create({
        data: { ...tenant(), planKey: "free", billingStatus: "NONE" },
      });
    });

    await inAlpha(async () => {
      // A free shop could otherwise spend a model call here: `aiGate("draft")`
      // without a feature can never answer "plan", so the whole locked state
      // was unreachable and nothing stopped the POST.
      await expect(fillMissing({ locale: "ar", actor: ACTOR })).rejects.toBeInstanceOf(
        Response,
      );
      expect(await db.storefrontString.count()).toBe(0);
    });
  });

  it("is refused when the merchant has switched drafting off", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await saveSettings("agent", new FormData(), { actor: ACTOR });

      // Enforcement, not a disabled button — the 6.5 lesson.
      await expect(fillMissing({ locale: "ar", actor: ACTOR })).rejects.toBeInstanceOf(
        Response,
      );
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("import", () => {
  const file = (locale: string, strings: Record<string, unknown>) =>
    JSON.stringify({ locale, strings });

  it("puts the merchant's own file in front of the buyer", async () => {
    await installShop(ALPHA);
    const key = plainKey();

    await inAlpha(async () => {
      const outcome = await importStrings({
        locale: "en",
        content: file("en", { [key]: "Straight from the spreadsheet." }),
        actor: ACTOR,
      });

      expect(outcome.applied).toBe(1);
      expect(outcome.rejected).toEqual([]);
      // The same question the whole feature turns on: did it reach the buyer?
      expect((await getFixedT("en"))(key)).toBe("Straight from the spreadsheet.");
    });
  });

  it("leaves every string the file does not mention alone", async () => {
    await installShop(ALPHA);
    const [first, second] = editableKeys();

    await inAlpha(async () => {
      await saveString({ key: second!, locale: "en", value: "Mine." }, { actor: ACTOR });
      await importStrings({
        locale: "en",
        content: file("en", { [first!]: "Theirs." }),
        actor: ACTOR,
      });

      // An import that replaced the whole catalogue would wipe the wording of
      // anybody who exported before they had finished editing.
      const kept = await db.storefrontString.findFirstOrThrow({
        where: { key: second!, locale: "en" },
      });
      expect(kept.value).toBe("Mine.");
    });
  });

  it("refuses a file for another language whole, rather than string by string", async () => {
    await installShop(ALPHA);
    const key = editableKeys()[0]!;

    await inAlpha(async () => {
      // Arabic imported as English would put Arabic on the English storefront
      // one string at a time, with nothing to say it had happened.
      await expect(
        importStrings({
          locale: "en",
          content: file("ar", { [key]: "كلماتنا." }),
          actor: ACTOR,
        }),
      ).rejects.toBeInstanceOf(ImportInvalid);
      expect(await db.storefrontString.count()).toBe(0);
    });
  });

  it("refuses a file that is not the one this page exports", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await expect(
        importStrings({
          locale: "en",
          content: "key,value\nforms.submit,Apply",
          actor: ACTOR,
        }),
      ).rejects.toBeInstanceOf(ImportInvalid);
      await expect(
        importStrings({ locale: "en", content: JSON.stringify([1, 2]), actor: ACTOR }),
      ).rejects.toBeInstanceOf(ImportInvalid);
    });
  });

  it("names every string it refused, instead of applying what it could quietly", async () => {
    await installShop(ALPHA);
    const tagged = editableKeys().find(
      (one) => placeholdersIn(shippedString(one, "en") ?? "").length > 0,
    )!;
    const plain = editableKeys().find(
      (one) => placeholdersIn(shippedString(one, "en") ?? "").length === 0,
    )!;

    await inAlpha(async () => {
      const outcome = await importStrings({
        locale: "en",
        content: file("en", {
          [plain]: "Fine.",
          [tagged]: "Lost the tag.",
          "settings.heading": "Not mine to change.",
          "forms.nothing.here": "Not a key at all.",
          [editableKeys()[3]!]: "   ",
        }),
        actor: ACTOR,
      });

      expect(outcome.applied).toBe(1);
      // A merchant told "imported" whose wording was quietly dropped finds out
      // from a buyer. Every refusal is named, with its reason.
      expect(outcome.rejected).toEqual(
        expect.arrayContaining([
          { key: tagged, reason: "placeholders" },
          { key: "settings.heading", reason: "unknownKey" },
          { key: "forms.nothing.here", reason: "unknownKey" },
          { key: editableKeys()[3]!, reason: "empty" },
        ]),
      );
      expect(await db.storefrontString.count()).toBe(1);
    });
  });

  it("counts a string the file already agreed with rather than claiming it changed", async () => {
    await installShop(ALPHA);
    const key = editableKeys()[0]!;

    await inAlpha(async () => {
      await saveString({ key, locale: "en", value: "Same." }, { actor: ACTOR });
      const outcome = await importStrings({
        locale: "en",
        content: file("en", { [key]: "Same." }),
        actor: ACTOR,
      });

      expect(outcome).toMatchObject({ applied: 0, unchanged: 1 });
    });
  });

  it("clears the review flag on an ✦ suggestion a person imported over", async () => {
    await installShop(ALPHA);
    const key = editableKeys()[0]!;

    await inAlpha(async () => {
      await saveString(
        { key, locale: "en", value: "Suggested.", needsReview: true },
        { actor: ACTOR },
      );
      await importStrings({
        locale: "en",
        content: file("en", { [key]: "A person wrote this file." }),
        actor: ACTOR,
      });

      const row = await db.storefrontString.findFirstOrThrow({ where: { key } });
      expect(row.needsReview).toBe(false);
      expect(row.aiFilled).toBe(false);
    });
  });

  it("refuses a file with more strings than this app has", async () => {
    await installShop(ALPHA);
    const flood = Object.fromEntries(
      Array.from({ length: editableKeys().length + 1 }, (_, at) => [`k${at}`, "x"]),
    );

    await inAlpha(async () => {
      await expect(
        importStrings({ locale: "en", content: file("en", flood), actor: ACTOR }),
      ).rejects.toBeInstanceOf(ImportInvalid);
    });
  });

  it("treats a prototype key as a key it does not know", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const outcome = await importStrings({
        locale: "en",
        content: '{"locale":"en","strings":{"__proto__":"x","constructor":"y"}}',
        actor: ACTOR,
      });

      expect(outcome.applied).toBe(0);
      expect(outcome.rejected.map((one) => one.reason)).toEqual([
        "unknownKey",
        "unknownKey",
      ]);
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });
  });

  it("is one shop's file and never another's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const key = editableKeys()[0]!;

    await inAlpha(() =>
      importStrings({
        locale: "en",
        content: file("en", { [key]: "Alpha's file." }),
        actor: ACTOR,
      }),
    );

    await inBeta(async () => {
      expect(await db.storefrontString.count()).toBe(0);
      expect((await getFixedT("en"))(key)).not.toBe("Alpha's file.");
    });
  });

  it("records the count and the language, never the words", async () => {
    await installShop(ALPHA);
    const key = editableKeys()[0]!;

    await inAlpha(async () => {
      await importStrings({
        locale: "en",
        content: file("en", { [key]: "Something a buyer will read." }),
        actor: ACTOR,
      });

      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "storefront_string.imported" },
      });
      expect(entry.summary).not.toContain("Something a buyer");
      expect(JSON.stringify(entry.metadata)).not.toContain("Something a buyer");
    });
  });

  it("round-trips its own export", async () => {
    await installShop(ALPHA);
    const key = plainKey();

    await inAlpha(async () => {
      await saveString({ key, locale: "en", value: "Ours." }, { actor: ACTOR });
      const exported = await exportStrings("en");
      await saveString({ key, locale: "en", value: "  " }, { actor: ACTOR });

      // The file this page hands a merchant has to be a file this page takes
      // back, or "export/import" is one feature and a dead end.
      const outcome = await importStrings({
        locale: "en",
        content: exported,
        actor: ACTOR,
      });
      expect(outcome.applied).toBe(1);
      expect((await getFixedT("en"))(key)).toBe("Ours.");
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("export", () => {
  it("carries the merchant's own strings and nothing else", async () => {
    await installShop(ALPHA);
    const key = plainKey();

    await inAlpha(async () => {
      await saveString({ key, locale: "en", value: "Ours." }, { actor: ACTOR });
      const file = JSON.parse(await exportStrings("en"));

      // Exporting five hundred shipped strings would make a merchant the owner
      // of every one of them, including the ones Mannon improves next release.
      expect(Object.keys(file.strings)).toEqual([key]);
      expect(file.locale).toBe("en");
    });
  });
});

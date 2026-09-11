import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { useTranslation } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { getFixedT } from "~/i18n.server";
import { ShopWording } from "~/components/i18n/ShopWording";
import { fillMissing } from "~/lib/i18n/fill.server";
import {
  editableKeys,
  listStrings,
  overridesFor,
  saveString,
  shippedString,
} from "~/lib/i18n/strings.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * The 6.6 cold read's findings, kept as tests.
 *
 * Every one of these failed against `2ecabba`, which passed its own gate. The
 * worst was P0-4: `addResource` writes into the object it is handed, and this
 * process handed it the imported `en.json` — so one shop saving one string
 * rewrote the shipped catalogue for the whole Node process, and the next
 * request from any other shop served that shop's wording to *their* buyers.
 *
 * They stay here rather than being folded into `translations.test.ts` because
 * each one names the shape of a bug rather than a feature, and the names are
 * worth reading the next time this area is touched.
 */

const ALPHA = "alpha.myshopify.com";
const inAlpha = <T,>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const ACTOR = { type: "STAFF" as const, id: "staff-1" };

function reply(text: string) {
  return {
    id: "msg_01tr",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0 },
  };
}
const once = (text: string) => ({ create: async () => reply(text) }) as never;

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

/* ------------------------------------------------------------------ P0-1 */

function BuyerSurface() {
  const { t } = useTranslation();
  return <p>{t("forms.public.submit")}</p>;
}

describe("P0-1 the page a buyer loads ignores every override", () => {
  it("puts the merchant's wording on the buyer's page", async () => {
    await installShop(ALPHA);

    const overrides = await inAlpha(async () => {
      await saveString(
        { key: "forms.public.submit", locale: "en", value: "Send it over" },
        { actor: ACTOR },
      );
      return overridesFor("en");
    });

    // What the route does: the loader looks the shop up, reads its wording,
    // and the component hands it to its own subtree. The instance
    // `entry.server.tsx` builds cannot do this — it has no shop, and for
    // `/f/:publicId` it cannot get one without redoing the loader's lookup.
    const html = renderToStaticMarkup(
      <ShopWording locale="en" overrides={overrides}>
        <BuyerSurface />
      </ShopWording>,
    );

    expect(html).toContain("Send it over");
  });

  it("is provided by every route that renders a buyer-facing page", () => {
    // The registration step this would otherwise become: a third buyer page
    // added later, rendering Mannon's words at somebody's customers with every
    // test still green.
    for (const route of ["f.$publicId.tsx", "q.$publicId.tsx"]) {
      const source = readFileSync(resolve(process.cwd(), "app/routes", route), "utf8");
      expect(source, route).toContain("ShopWording");
    }
  });
});

/* ------------------------------------------------------------------ P0-2 */

describe("P0-2 the public quote built `t` before it entered the tenant", () => {
  it("translates the quote page in the merchant's words", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await saveString(
        { key: "quotes.public.accept", locale: "en", value: "Take these prices" },
        { actor: ACTOR },
      );

      const t = await getFixedT("en");
      expect(t("quotes.public.accept")).toBe("Take these prices");
    });
  });

  it("opens the shop's scope before it builds one", () => {
    // `getFixedT` outside a scope is not an error — the login page and the
    // error boundary both translate without a tenant — so it comes back
    // silently with Mannon's words. Order is the whole of the bug.
    const source = readFileSync(
      resolve(process.cwd(), "app/routes/q.$publicId.tsx"),
      "utf8",
    );
    expect(source.indexOf("shopScope.run")).toBeLessThan(source.indexOf("getFixedT("));
  });
});

/* ------------------------------------------------------------------ P0-3 */

describe("P0-3 an ✦ suggestion is live before anyone reads it", () => {
  it("does not reach a buyer until a person accepts it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const key = editableKeys()[0]!;
      const shipped = (await getFixedT("ar"))(key);

      await fillMissing(
        { locale: "ar", actor: ACTOR },
        { messages: once(JSON.stringify({ translations: { [key]: "كلام كلود" } })) },
      );

      const row = await db.storefrontString.findFirstOrThrow({ where: { key } });
      expect(row.needsReview).toBe(true);

      // translations.fillPromise: "nothing reaches a buyer as your words until
      // you accept it". Spec line 130: "never auto-publish a language the
      // merchant hasn't seen."
      expect((await getFixedT("ar"))(key)).toBe(shipped);
    });
  });

  it("records the AI write as an AI write", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const key = editableKeys()[0]!;
      await fillMissing(
        { locale: "ar", actor: ACTOR },
        { messages: once(JSON.stringify({ translations: { [key]: "كلام كلود" } })) },
      );

      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "storefront_string.filled" },
      });
      // Every other ✦ write path records the model and the prompt version.
      expect(entry.aiModel).not.toBeNull();
      expect(entry.aiPromptVersion).not.toBeNull();
    });
  });
});

/* ------------------------------------------------------------------ P1-1 */

describe("P1-1 the `missing only` filter", () => {
  it("can return a row on some store, in some language", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      // It used to mean "no translation in this locale at all", which both
      // catalogues make impossible: `shipped` was always truthy, so the filter
      // always produced the empty state. It now means what the ✦ panel beside
      // it counts — and it has to be able to return a row on a fresh install.
      const before = await listStrings({ locale: "ar", unwrittenOnly: true });
      expect(before.total).toBeGreaterThan(0);

      const key = editableKeys()[0]!;
      await saveString({ key, locale: "ar", value: "كلماتنا." }, { actor: ACTOR });

      const after = await listStrings({ locale: "ar", unwrittenOnly: true });
      expect(after.total).toBe(before.total - 1);
    });
  });
});

/* ------------------------------------------------------------------ P1-2 */

describe("P1-2 the captured states were of rows the route cannot emit", () => {
  it("captures keys the catalogue actually carries", () => {
    // The nine screenshots were of `forms.submit`, `quotes.expiresIn` and
    // `approval.welcome` — none of which exists. `listStrings` could never
    // emit them, so the whole capture set was of fabricated data, and the
    // raw-key guard could not see it: those elements are the ones carrying
    // `data-string-key`.
    const fixture = readFileSync(
      resolve(process.cwd(), "tests/unit/translations-page-states.test.tsx"),
      "utf8",
    );
    const used = [...fixture.matchAll(/key: "([a-z][A-Za-z0-9_.]+)"/gu)].map(
      (match) => match[1]!,
    );

    expect(used.length).toBeGreaterThan(0);
    const editable = new Set(editableKeys());
    // `settings.heading` is in there on purpose: it is the fixture's example
    // of a key an import must refuse.
    for (const key of used.filter((one) => one !== "settings.heading")) {
      expect(editable, key).toContain(key);
    }
  });
});

/* ------------------------------------------------------------------ P1-3 */

describe("P1-3 the editable set is what the page says it is", () => {
  it("does not offer a merchant strings no buyer ever reads", () => {
    // `limit.*` is the Plans page's allowance copy (PlansPage.tsx:117,187,
    // 291-297) and `approval.*` is the merchant's own criteria builder
    // (FormBuilderPage.tsx). Neither reaches a buyer.
    expect(editableKeys().filter((key) => key.startsWith("limit."))).toEqual([]);
    expect(editableKeys().filter((key) => key.startsWith("approval."))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ P0-4 */

describe("P0-4 does one shop's wording stay in one shop's process", () => {
  it("does not leak into the next request, for another shop", async () => {
    await installShop(ALPHA);
    await installShop("beta.myshopify.com");
    const key = "forms.public.submit";

    const shipped = await shopScope.run("beta.myshopify.com", async () =>
      (await getFixedT("en"))(key),
    );

    await inAlpha(async () => {
      await saveString({ key, locale: "en", value: "ALPHA ONLY" }, { actor: ACTOR });
      // The instance is built *inside* Alpha's scope, with Alpha's overrides.
      expect((await getFixedT("en"))(key)).toBe("ALPHA ONLY");
    });

    await shopScope.run("beta.myshopify.com", async () => {
      expect((await getFixedT("en"))(key)).toBe(shipped);
    });
  });
});

/* ------------------------------------------------------------------ P0-5 */

describe("P0-5 the shipped catalogue is a constant", () => {
  it("is not rewritten by one shop's override", async () => {
    await installShop(ALPHA);
    const key = "forms.public.chooseOption";
    const before = shippedString(key, "en");

    await inAlpha(async () => {
      await saveString({ key, locale: "en", value: "ALPHA ONLY" }, { actor: ACTOR });
      await getFixedT("en");
    });

    // "Mannon ships: …" on every other shop's Translations page, the source the
    // placeholder check compares against, and the English an ✦ fill translates.
    expect(shippedString(key, "en")).toBe(before);
  });
});

/* ------------------------------------------------------------------ P0-6 */

describe("P0-6 clearing a string", () => {
  it("comes back to Mannon's words once the page has rendered in between", async () => {
    await installShop(ALPHA);
    const key = "forms.public.required";

    await inAlpha(async () => {
      const shipped = (await getFixedT("en"))(key);

      await saveString({ key, locale: "en", value: "MUST HAVE" }, { actor: ACTOR });
      // What production does between the two: the save redirects and the
      // loader renders the table.
      await getFixedT("en");

      await saveString({ key, locale: "en", value: "" }, { actor: ACTOR });
      expect(await db.storefrontString.count()).toBe(0);
      expect((await getFixedT("en"))(key)).toBe(shipped);
    });
  });
});

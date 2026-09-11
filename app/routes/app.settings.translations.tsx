import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import { TranslationsPage } from "~/components/settings/TranslationsPage";
import type { TranslationsView } from "~/components/settings/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import {
  isSupportedLocale,
  LANGUAGE_NAMES,
  SUPPORTED_LOCALES,
  type Locale,
} from "~/i18n/config";
import { translate, type Translate } from "~/i18n/translate";
import { MAX_IMPORT_BYTES } from "~/lib/i18n/limits";
import { aiGate } from "~/lib/ai/permissions.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import {
  fillMissing,
  ImportInvalid,
  importStrings,
  unwrittenIn,
  type ImportOutcome,
} from "~/lib/i18n/fill.server";
import {
  acceptString,
  listStrings,
  placeholdersIn,
  saveString,
  shippedString,
  StringInvalid,
  STRINGS_PAGE_SIZE,
} from "~/lib/i18n/strings.server";
import { publishLimits } from "~/lib/orders/limits.server";
import { withAdmin } from "~/shopify.server";

/**
 * Settings → Translations.
 *
 * Its own route rather than a card: the table is the page.
 */

/** The filters, as a URL, so a filtered table is a link. */
function keeping(url: URL, overrides: Record<string, string> = {}): string {
  const kept = new URLSearchParams();
  for (const key of ["locale", "search", "unwritten", "review", "page"]) {
    const value = overrides[key] ?? url.searchParams.get(key);
    if (value) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `/app/settings/translations?${query}` : "/app/settings/translations";
}

async function buildView(
  request: Request,
  t: Translate,
  extra: {
    fill?: { filled: number; failure: string | null };
    issue?: { key: string; message: string };
    imported?: ImportOutcome;
    importIssue?: TranslationsView["importIssue"];
  } = {},
): Promise<TranslationsView> {
  const url = new URL(request.url);
  const asked = url.searchParams.get("locale") ?? "";
  const locale: Locale = isSupportedLocale(asked) ? asked : "ar";

  const search = url.searchParams.get("search") ?? "";
  const unwrittenOnly = url.searchParams.get("unwritten") === "on";
  const reviewOnly = url.searchParams.get("review") === "on";
  const page = Number(url.searchParams.get("page") ?? 1) || 1;

  const [strings, pending, gate] = await Promise.all([
    listStrings({ locale, search, unwrittenOnly, reviewOnly, page }),
    unwrittenIn(locale),
    // The feature matters: without it `blockedBy` can never be "plan", so the
    // "this needs the {{plan}} plan" state could not render and a free shop
    // could spend a model call here.
    aiGate("draft", { feature: "merchant_agent" }),
  ]);

  const pages = Math.max(1, Math.ceil(strings.total / STRINGS_PAGE_SIZE));

  return {
    locale,
    locales: SUPPORTED_LOCALES.map((code) => ({ code, name: LANGUAGE_NAMES[code] })),
    search,
    unwrittenOnly,
    reviewOnly,
    filtered: search !== "" || unwrittenOnly || reviewOnly,

    rows: strings.rows.map((row) => ({
      key: row.key,
      shipped: row.shipped,
      value: row.value,
      needsReview: row.needsReview,
      // From the English, always: it is the source a translation has to match,
      // and a locale that ships nothing for this key has no placeholders of
      // its own to compare against.
      placeholders: placeholdersIn(shippedString(row.key, "en") ?? row.shipped),
      error: extra.issue?.key === row.key ? extra.issue.message : null,
    })),
    total: strings.total,
    page: strings.page,
    pages,
    nextHref:
      strings.page < pages ? keeping(url, { page: String(strings.page + 1) }) : null,
    previousHref:
      strings.page > 1 ? keeping(url, { page: String(strings.page - 1) }) : null,

    imported: extra.imported ?? null,
    importIssue: extra.importIssue ?? null,

    fill: {
      pending: pending.length,
      filled: extra.fill?.filled ?? 0,
      locked: gate.allowed ? null : gate.blockedBy,
      requiredPlan:
        gate.blockedBy === "plan"
          ? // The plan's name, not its key: "This needs the pro plan" is the
            // raw `PlanKey` reaching a merchant.
            t(`planName.${lowestPlanWithFeature("merchant_agent")}`)
          : null,
      failure: extra.fill?.failure ?? null,
      running: false,
    },
  };
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const t = translate(await getFixedT(detectLocale(request)));
    return json({ view: await buildView(request, t) });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session, admin }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const t = translate(await getFixedT(detectLocale(request)));
    const actor = { type: "STAFF" as const, id: session.id };

    if (intent === "fill") {
      const asked = (form.get("locale") ?? "").toString();
      const locale: Locale = isSupportedLocale(asked) ? asked : "ar";
      const result = await fillMissing({ locale, actor });

      return json({
        view: await buildView(request, t, {
          fill: { filled: result.filled, failure: result.failure },
        }),
      });
    }

    if (intent === "import") {
      const asked = (form.get("locale") ?? "").toString();
      const locale: Locale = isSupportedLocale(asked) ? asked : "ar";
      const file = form.get("file");

      if (!(file instanceof File) || file.size === 0) {
        return json(
          { view: await buildView(request, t, { importIssue: "noFile" }) },
          { status: 422 },
        );
      }
      if (file.size > MAX_IMPORT_BYTES) {
        return json(
          { view: await buildView(request, t, { importIssue: "tooBig" }) },
          { status: 422 },
        );
      }

      try {
        const outcome = await importStrings({
          locale,
          content: await file.text(),
          actor,
        });
        if (outcome.applied > 0) await publishLimits(admin);
        return json({ view: await buildView(request, t, { imported: outcome }) });
      } catch (error) {
        if (error instanceof ImportInvalid) {
          return json(
            { view: await buildView(request, t, { importIssue: error.code }) },
            { status: 422 },
          );
        }
        throw error;
      }
    }

    if (intent !== "save") throw new Response("Unknown intent", { status: 400 });

    // One Save for the page. Every row carries what it said when the page was
    // drawn, so an untouched row stays untouched rather than being adopted as
    // the merchant's own wording — and a row a merchant edited is never lost
    // because they pressed Save on a different one.
    const locale = (form.get("locale") ?? "").toString();
    let touchedCheckout = false;
    let issue: { key: string; message: string } | undefined;

    for (const [field, raw] of form.entries()) {
      if (!field.startsWith("value:")) continue;
      const key = field.slice("value:".length);
      const value = raw.toString();
      if (value === (form.get(`was:${key}`) ?? "").toString()) continue;

      try {
        await saveString({ key, locale, value }, { actor });
        if (key.startsWith("checkout.")) touchedCheckout = true;
      } catch (error) {
        if (!(error instanceof StringInvalid)) throw error;
        // The first one that failed, beside the field that caused it. The rest
        // of the page is still saved: refusing every row because one had a
        // missing tag would be a worse answer than refusing the one.
        issue ??= { key, message: t(`translations.issue.${error.code}`) };
      }
    }

    for (const field of form.keys()) {
      if (!field.startsWith("accept:")) continue;
      const key = field.slice("accept:".length);
      await acceptString({ key, locale }, { actor });
      if (key.startsWith("checkout.")) touchedCheckout = true;
    }

    if (issue) {
      return json({ view: await buildView(request, t, { issue }) }, { status: 422 });
    }

    // The checkout message is not rendered by this app at all: it lives in a
    // metafield the Function reads. Without this, the table would show the
    // merchant's new wording while every buyer kept reading the old one.
    if (touchedCheckout) await publishLimits(admin);

    const url = new URL(request.url);
    return redirect(keeping(url));
  });

export default function Translations() {
  const answered = useActionData<typeof action>();
  const loaded = useLoaderData<typeof loader>();
  const { view } = answered ?? loaded;

  // One fill is up to 25 strings through the model: a real wait, and a page
  // that looks unchanged is a page a merchant presses again.
  const navigation = useNavigation();
  const running =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "fill";

  return (
    <TranslationsPage
      view={{
        ...(view as TranslationsView),
        fill: { ...(view as TranslationsView).fill, running },
      }}
    />
  );
}

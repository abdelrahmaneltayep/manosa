import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { SettingsPage } from "~/components/settings/SettingsPage";
import type { SettingsView } from "~/components/settings/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { pauseApp, resumeApp } from "~/lib/settings/pause.server";
import { isSection, saveSettings, SettingsInvalid } from "~/lib/settings/settings.server";
import { settingsView } from "~/lib/settings/view-model.server";
import { withAdmin } from "~/shopify.server";

/**
 * Settings — the merchant's own half.
 *
 * Every section posts to this one action and names itself, so a section's
 * failure belongs to that section and leaves the rest of the page alone.
 */

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));

    return json({
      view: await settingsView({
        locale,
        t,
        saved: url.searchParams.get("saved"),
        confirming: url.searchParams.get("confirm") === "pause",
      }),
    });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const section = (form.get("section") ?? "").toString();
    const intent = (form.get("intent") ?? "").toString();
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));
    const actor = { type: "STAFF" as const, id: session.id };

    if (section === "danger") {
      if (intent === "pause") await pauseApp({ admin, actor });
      else if (intent === "resume") await resumeApp({ admin, actor });
      else throw new Response("Unknown intent", { status: 400 });

      // Redirected, so a refresh cannot pause twice and the confirm state in
      // the query string is cleared.
      return redirect("/app/settings");
    }

    if (!isSection(section)) throw new Response("Unknown section", { status: 400 });

    if (intent === "verify") {
      // The provider that would check the records is not configured here, and
      // a Verify that reports success without checking is the one thing this
      // button must never do. See qa/6.4/REPORT.md → what this cannot prove.
      throw new Response("Sender verification is not configured", { status: 501 });
    }

    try {
      await saveSettings(section, form, { actor });
    } catch (error) {
      if (error instanceof SettingsInvalid) {
        return json(
          {
            view: await settingsView({
              locale,
              t,
              failedSection: section,
              issues: error.issues,
            }),
          },
          { status: 422 },
        );
      }
      throw error;
    }

    return redirect(`/app/settings?saved=${section}`);
  });

export default function Settings() {
  // A non-redirect action re-runs the loader, so the action's view is the
  // fresher of the two whenever there is one.
  const answered = useActionData<typeof action>();
  const loaded = useLoaderData<typeof loader>();
  const { view } = answered ?? loaded;

  return <SettingsPage view={view as SettingsView} />;
}

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { FormListPage } from "~/components/forms/FormListPage";
import type { FormCardView, FormListView } from "~/components/forms/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { loadEntitlements } from "~/lib/billing/entitlements.server";
import { isPlanGateError } from "~/lib/billing/gate.server";
import { PLANS } from "~/lib/billing/plans";
import { readEmails, validateEmails } from "~/lib/forms/merge-tags";
import { readDefinition, validateDefinition } from "~/lib/forms/schema";
import {
  archiveForm,
  createFromTemplate,
  duplicateForm,
  FORM_TEMPLATES,
  listForms,
  statsFor,
} from "~/lib/forms/forms.server";
import { isFormTemplateKey } from "~/lib/forms/templates";
import { publicUrlFor } from "~/lib/forms/urls.server";
import { withAdmin } from "~/shopify.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const t = await getFixedT(detectLocale(request));
    const now = new Date();

    const [rows, entitlements] = await Promise.all([listForms(), loadEntitlements(now)]);
    const stats = await statsFor(
      rows.map((row) => row.id),
      now,
    );

    const limit = entitlements.limits.forms;

    const cards: FormCardView[] = rows.map((row) => {
      const counts = stats.get(row.id) ?? { views: 0, submissions: 0 };
      const issues =
        validateDefinition(readDefinition(row.fields)).length +
        validateEmails(readEmails(row.emails)).length;

      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        submissions30d: counts.submissions,
        views30d: counts.views,
        // Never measured is not zero per cent: a form nobody has opened has no
        // conversion rate, and showing 0% would be a claim about it.
        conversion:
          counts.views === 0
            ? null
            : Math.round((counts.submissions / counts.views) * 100),
        lastEditedAt: row.updatedAt.toISOString(),
        publicUrl: publicUrlFor(request, row.publicId),
        blockingIssues: issues,
      };
    });

    const view: FormListView = {
      rows: cards,
      templates: Object.values(FORM_TEMPLATES).map((template) => ({
        key: template.key,
        name: t(template.i18nKey),
        description: t(template.descriptionKey),
      })),
      atFormLimit: limit !== null && rows.length >= limit,
      requiredPlan:
        limit === null
          ? null
          : (Object.values(PLANS)
              .sort((a, b) => a.rank - b.rank)
              .find((plan) => plan.limits.forms === null)?.key ?? null),
      // ✦ Generating a form from a sentence lands with the AI layer in 4.3.
      aiAvailable: false,
    };

    return json({ view });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const form = await request.formData();
    const intent = form.get("intent");
    const t = await getFixedT(detectLocale(request));
    const actor = { type: "STAFF" as const, id: session.id };

    try {
      if (intent === "template") {
        const key = (form.get("template") ?? "").toString();
        if (!isFormTemplateKey(key))
          throw new Response("Unknown template", { status: 400 });

        const created = await createFromTemplate(
          FORM_TEMPLATES[key],
          (catalogKey) => t(catalogKey),
          actor,
        );
        return redirect(`/app/forms/${created.id}`);
      }

      if (intent === "duplicate") {
        const formId = (form.get("formId") ?? "").toString();
        if (!formId) throw new Response("Missing form", { status: 400 });
        const copy = await duplicateForm(formId, actor, t("forms.list.copySuffix"));
        return redirect(`/app/forms/${copy.id}`);
      }

      if (intent === "archive") {
        const formId = (form.get("formId") ?? "").toString();
        if (!formId) throw new Response("Missing form", { status: 400 });
        await archiveForm(formId, actor);
        return redirect("/app/forms");
      }

      // ✦ Generate is not built yet; the button is disabled, and a hand-made
      // request gets the same answer rather than a half-built path.
      if (intent === "generate") return redirect("/app/forms");
    } catch (error) {
      if (isPlanGateError(error)) return redirect("/app/forms");
      throw error;
    }

    throw new Response("Unknown intent", { status: 400 });
  });

export default function FormsIndex() {
  const { view } = useLoaderData<typeof loader>();
  return <FormListPage view={view as FormListView} />;
}

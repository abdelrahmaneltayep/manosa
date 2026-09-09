import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { FormBuilderPage } from "~/components/forms/FormBuilderPage";
import type { BuilderTab, FormBuilderView } from "~/components/forms/types";
import { db } from "~/db.server";
import { clampWidth, isSafeRedirect } from "~/lib/forms/appearance";
import { checkContrast } from "~/lib/forms/contrast";
import {
  FormValidationError,
  getForm,
  issuesFor,
  updateForm,
  type LoadedForm,
} from "~/lib/forms/forms.server";
import type { EmailKey } from "~/lib/forms/merge-tags";
import { EMAIL_KEYS } from "~/lib/forms/merge-tags";
import { FIELD_KINDS, type FieldKind, type FormField } from "~/lib/forms/schema";
import { listSubmissions } from "~/lib/forms/submissions.server";
import { publicUrlFor } from "~/lib/forms/urls.server";
import { vatExampleFor } from "~/lib/forms/vat-formats";
import { canSendEmail } from "~/lib/email/send.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

/** Applications shown on the Publish tab. The full queue is phase 2.3. */
const RECENT_LIMIT = 5;

const TABS: BuilderTab[] = ["configuration", "appearance", "emails", "publish"];

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const id = params.id!;

    const loaded = await getForm(id);
    // Another shop's form id reads as not found — the scoped client never sees
    // it, and that is the answer a stranger's id deserves.
    if (!loaded || loaded.row.archivedAt) {
      throw new Response("Form not found", { status: 404 });
    }

    const requested = url.searchParams.get("tab") as BuilderTab | null;
    const tab = requested && TABS.includes(requested) ? requested : "configuration";

    const [groups, shop, recent] = await Promise.all([
      db.customerGroup.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true },
      }),
      db.shop.findUnique({
        where: { shop: shopScope.require("forms") },
        select: { countryCode: true },
      }),
      listSubmissions({ formId: id, pageSize: RECENT_LIMIT }),
    ]);

    const { definitionIssues, emailIssues } = issuesFor(toInput(loaded));

    const view: FormBuilderView = {
      id: loaded.row.id,
      name: loaded.row.name,
      slug: loaded.row.slug,
      status: loaded.row.status,
      tab,
      fields: loaded.definition.fields.map((field, index) => ({
        ...field,
        index,
        canBeCondition: field.kind === "select" || field.kind === "text",
      })),
      appearance: loaded.appearance,
      emails: loaded.emails,
      publish: loaded.publish,
      groups,
      definitionIssues,
      emailIssues,
      contrast: {
        text: checkContrast(loaded.appearance.text, loaded.appearance.background),
        accent: checkContrast(loaded.appearance.accentText, loaded.appearance.accent),
      },
      publicUrl: publicUrlFor(request, loaded.row.publicId),
      recent: recent.rows.map((row) => ({
        id: row.id,
        who: row.company ?? row.email,
        at: row.createdAt.toISOString(),
        status: row.status,
        vatStatus: row.vatStatus,
        uploads: row.uploads.map((upload) => ({
          id: upload.id,
          fileName: upload.fileName,
          scanned: upload.scannedAt !== null,
        })),
      })),
      recentTotal: recent.total,
      testSend: url.searchParams.get("test") as FormBuilderView["testSend"],
      vatExample: vatExampleFor(shop?.countryCode),
      saving: false,
    };

    return json({ view });
  });

function toInput(loaded: LoadedForm) {
  return {
    name: loaded.row.name,
    slug: loaded.row.slug,
    definition: loaded.definition,
    appearance: loaded.appearance,
    emails: loaded.emails,
    publish: loaded.publish,
    status: loaded.row.status,
  };
}

const list = (value: FormDataEntryValue | null) =>
  (value ?? "")
    .toString()
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const action = ({ request, params }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const id = params.id!;
    const actor = { type: "STAFF" as const, id: session.id };

    const loaded = await getForm(id);
    if (!loaded || loaded.row.archivedAt) {
      throw new Response("Form not found", { status: 404 });
    }

    const input = toInput(loaded);
    let tab: BuilderTab = "configuration";

    switch (intent) {
      case "details":
        input.name = (form.get("name") ?? "").toString().trim() || loaded.row.name;
        input.slug = (form.get("slug") ?? "").toString().trim() || loaded.row.slug;
        break;

      case "addField": {
        const label = (form.get("label") ?? "").toString().trim();
        const kind = (form.get("kind") ?? "text").toString() as FieldKind;
        if (!label || !FIELD_KINDS.includes(kind)) {
          throw new Response("Bad field", { status: 400 });
        }
        input.definition = {
          ...input.definition,
          fields: [
            ...input.definition.fields,
            {
              key: uniqueKey(label, input.definition.fields),
              kind,
              label,
              help: null,
              placeholder: null,
              required: form.get("required") === "yes",
              options: kind === "select" ? list(form.get("options")) : undefined,
              showWhen: null,
            },
          ],
        };
        break;
      }

      case "removeField": {
        const key = (form.get("key") ?? "").toString();
        input.definition = {
          ...input.definition,
          fields: input.definition.fields
            .filter((field) => field.key !== key)
            // A condition pointing at a field that no longer exists would make
            // its own field permanently invisible. Dropping the condition is
            // the only outcome that leaves a working form.
            .map((field) =>
              field.showWhen?.field === key ? { ...field, showWhen: null } : field,
            ),
        };
        break;
      }

      case "toggleRequired": {
        const key = (form.get("key") ?? "").toString();
        input.definition = {
          ...input.definition,
          fields: input.definition.fields.map((field) =>
            field.key === key ? { ...field, required: !field.required } : field,
          ),
        };
        break;
      }

      case "moveField": {
        const key = (form.get("key") ?? "").toString();
        const delta = form.get("direction") === "up" ? -1 : 1;
        input.definition = {
          ...input.definition,
          fields: moved(input.definition.fields, key, delta),
        };
        break;
      }

      case "setCondition": {
        const key = (form.get("key") ?? "").toString();
        const target = (form.get("conditionField") ?? "").toString();
        const value = (form.get("conditionValue") ?? "").toString().trim();
        input.definition = {
          ...input.definition,
          fields: input.definition.fields.map((field) =>
            field.key === key
              ? {
                  ...field,
                  showWhen: target && value ? { field: target, equals: value } : null,
                }
              : field,
          ),
        };
        break;
      }

      case "appearance":
        tab = "appearance";
        input.appearance = {
          ...input.appearance,
          layout: form.get("layout") === "boxed" ? "boxed" : "default",
          width: clampWidth(form.get("width")),
          font: (form.get("font") ?? "system").toString() as typeof input.appearance.font,
          background: (form.get("background") ?? "").toString(),
          text: (form.get("text") ?? "").toString(),
          accent: (form.get("accent") ?? "").toString(),
          accentText: (form.get("accentText") ?? "").toString(),
        };
        break;

      case "emails": {
        tab = "emails";
        const key = (form.get("email") ?? "").toString() as EmailKey;
        if (!EMAIL_KEYS.includes(key))
          throw new Response("Unknown email", { status: 400 });
        input.emails = {
          ...input.emails,
          [key]: {
            subject: (form.get("subject") ?? "").toString(),
            body: (form.get("body") ?? "").toString(),
          },
        };
        break;
      }

      case "testSend":
        // Nothing is sent, and the page says so. A button that reports success
        // while sending nothing is how a merchant discovers the problem from
        // an applicant who never got a confirmation.
        return redirect(
          `/app/forms/${id}?tab=emails&test=${canSendEmail() ? "sent" : "no_sender"}`,
        );

      case "publishSettings": {
        tab = "publish";
        const redirectUrl = (form.get("redirectUrl") ?? "").toString().trim();
        input.publish = {
          ...input.publish,
          // An unsafe redirect is dropped rather than stored: it would be a
          // phishing link the merchant published without knowing.
          redirectUrl: isSafeRedirect(redirectUrl) ? redirectUrl : "",
          autoTags: list(form.get("autoTags")),
          autoGroupId: (form.get("autoGroupId") ?? "").toString() || null,
          spamProtection: form.get("spamProtection") === "yes",
        };
        break;
      }

      case "status":
        tab = "publish";
        input.status = form.get("status") === "LIVE" ? "LIVE" : "DRAFT";
        break;

      default:
        throw new Response("Unknown intent", { status: 400 });
    }

    try {
      await updateForm(id, input, actor, admin);
    } catch (error) {
      // Only publishing is refused on issues; a draft may be unfinished. The
      // builder already lists them, so this lands back on the tab that has
      // the problem rather than on an error page.
      if (error instanceof FormValidationError) {
        return redirect(`/app/forms/${id}?tab=${tab}`);
      }
      throw error;
    }

    return redirect(`/app/forms/${id}?tab=${tab}`);
  });

function uniqueKey(label: string, fields: FormField[]): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 30) || "field";

  const taken = new Set(fields.map((field) => field.key));
  if (!taken.has(base)) return base;

  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${base}_${Date.now()}`;
}

function moved(fields: FormField[], key: string, delta: number): FormField[] {
  const index = fields.findIndex((field) => field.key === key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= fields.length) return fields;

  const next = [...fields];
  const [field] = next.splice(index, 1);
  next.splice(target, 0, field!);
  return next;
}

export default function FormBuilder() {
  const { view } = useLoaderData<typeof loader>();
  return <FormBuilderPage view={view as FormBuilderView} />;
}

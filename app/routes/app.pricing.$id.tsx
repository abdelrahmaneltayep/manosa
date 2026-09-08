import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { RuleBuilderPage } from "~/components/pricing/RuleBuilderPage";
import type { RuleBuilderView } from "~/components/pricing/types";
import { db } from "~/db.server";
import { parseRuleForm } from "~/lib/pricing/rule-form.server";
import { toEngineRule } from "~/lib/pricing/rule-mapper.server";
import { RulesetTooLargeError } from "~/lib/pricing/ruleset.server";
import {
  deleteRule,
  findDuplicateName,
  getRule,
  RuleConflictError,
  RuleValidationError,
  updateRule,
} from "~/lib/pricing/rules.server";
import { previewFor, toFormView } from "~/lib/pricing/view-model.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

async function shopCurrency(): Promise<string> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("currency") },
  });
  return shop?.currencyCode ?? "USD";
}

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const row = await getRule(params.id!);
    // Another shop's rule id resolves to nothing here, because the query is
    // tenant-scoped — so this 404 is also the cross-tenant answer.
    if (!row) throw new Response("Not found", { status: 404 });

    const currencyCode = await shopCurrency();
    const form = toFormView(row, currencyCode);

    const view: RuleBuilderView = {
      form,
      issues: [],
      duplicateName: (await findDuplicateName(row.name, row.id))?.name ?? null,
      preview: previewFor(toEngineRule(row), currencyCode, new Date()),
      conflict: null,
      saving: false,
    };

    return json({ view });
  });

export const action = ({ request, params }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "save").toString();
    const id = params.id!;
    const currencyCode = await shopCurrency();
    const actor = { type: "STAFF" as const, id: session.id };

    if (intent === "delete") {
      const row = await getRule(id);
      if (!row) throw new Response("Not found", { status: 404 });
      // The modal asks for the rule's name; check it server-side too, because
      // a permanent delete must not depend on the client having behaved.
      if ((form.get("confirmName") ?? "").toString().trim() !== row.name.trim()) {
        return json({ error: "name_mismatch" }, { status: 422 });
      }
      await deleteRule(id, { admin, actor });
      return redirect("/app/pricing?archived=1");
    }

    const existing = await getRule(id);
    if (!existing) throw new Response("Not found", { status: 404 });

    const parsed = parseRuleForm(form, {
      id,
      currencyCode,
      createdAt: existing.createdAt,
    });

    if (parsed.issues.length > 0) {
      return json(
        {
          view: {
            form: { ...toFormView(existing, currencyCode), ...echo(form) },
            issues: parsed.issues,
            duplicateName: null,
            preview: previewFor(parsed.rule, currencyCode, new Date()),
            conflict: null,
            saving: false,
          } satisfies RuleBuilderView,
        },
        { status: 422 },
      );
    }

    // "Overwrite with mine" takes the version they now hold, which is what the
    // conflict banner offered.
    const version = form.get("force") === "1" ? existing.version : parsed.version;

    try {
      await updateRule(id, parsed.rule, version, { admin, actor });
    } catch (error) {
      if (error instanceof RuleConflictError) {
        return json(
          {
            view: {
              form: { ...toFormView(existing, currencyCode), ...echo(form) },
              issues: [],
              duplicateName: null,
              preview: null,
              conflict: {
                name: error.current.name,
                theirVersion: error.current.version,
                theirUpdatedAt: error.current.updatedAt.toISOString(),
              },
              saving: false,
            } satisfies RuleBuilderView,
          },
          { status: 409 },
        );
      }
      if (error instanceof RuleValidationError) {
        return json({ view: { issues: error.issues } }, { status: 422 });
      }
      if (error instanceof RulesetTooLargeError) {
        return redirect("/app/pricing?publishError=too_large");
      }
      throw error;
    }

    return redirect(`/app/pricing/${id}?saved=1`);
  });

function echo(form: FormData) {
  const get = (key: string) => (form.get(key) ?? "").toString();
  return {
    name: get("name"),
    percentage: get("percentage"),
    amount: get("amount"),
    audienceTags: get("audienceTags"),
  };
}

export default function EditRule() {
  const { view } = useLoaderData<typeof loader>();
  return <RuleBuilderPage view={view as RuleBuilderView} />;
}

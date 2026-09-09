import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { GroupListPage } from "~/components/customers/GroupListPage";
import type { GroupListView } from "~/components/customers/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import {
  createGroup,
  createStarterGroups,
  deleteGroup,
  DuplicateGroupHandleError,
  GROUP_TEMPLATES,
  GroupHasMembersError,
  listGroups,
} from "~/lib/customers/groups.server";
import { pricingRuleCountsByTag } from "~/lib/customers/pricing-links.server";
import { toGroupRowView } from "~/lib/customers/view-model.server";
import { withAdmin } from "~/shopify.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const t = await getFixedT(detectLocale(request));

    const [groups, ruleCounts] = await Promise.all([
      listGroups(),
      pricingRuleCountsByTag(),
    ]);

    const taken = new Set(groups.map((group) => group.handle));
    const blockedId = url.searchParams.get("blocked");
    const blocked = blockedId
      ? (groups.find((group) => group.id === blockedId) ?? null)
      : null;

    const view: GroupListView = {
      rows: groups.map((group) =>
        toGroupRowView(group, {
          t: t as never,
          pricingRuleCount: ruleCounts.get(group.tag.toLowerCase()) ?? 0,
        }),
      ),
      templates: GROUP_TEMPLATES.filter((template) => !taken.has(template.handle)).map(
        (template) => ({ key: template.key, name: t(template.i18nKey) }),
      ),
      blockedDelete: blocked
        ? { id: blocked.id, name: blocked.name, memberCount: blocked.memberCount }
        : null,
      destinations: groups
        .filter((group) => group.id !== blockedId)
        .map((group) => ({ id: group.id, name: group.name })),
      error: url.searchParams.get("error") === "duplicate" ? "duplicate_handle" : null,
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
      if (intent === "starters") {
        await createStarterGroups(actor, (template) => t(template.i18nKey));
        return redirect("/app/customers/groups");
      }

      if (intent === "create") {
        const name = (form.get("name") ?? "").toString().trim();
        if (!name) throw new Response("Missing name", { status: 400 });
        const terms = (form.get("netTermsDays") ?? "").toString().trim();

        await createGroup(
          {
            name,
            tag: (form.get("tag") ?? "").toString().trim() || name,
            netTermsDays: terms ? Number(terms) : null,
          },
          actor,
        );
        return redirect("/app/customers/groups");
      }

      if (intent === "delete") {
        const groupId = (form.get("groupId") ?? "").toString();
        if (!groupId) throw new Response("Missing group", { status: 400 });

        const destination = (form.get("destinationId") ?? "").toString();
        await deleteGroup(
          groupId,
          destination === ""
            ? null
            : destination === "none"
              ? { kind: "none" }
              : { kind: "group", id: destination },
          actor,
        );
        return redirect("/app/customers/groups");
      }
    } catch (error) {
      // The guard is not an error page: it is the next step of the flow, so
      // the merchant lands back on the list being asked where the members go.
      if (error instanceof GroupHasMembersError) {
        return redirect(`/app/customers/groups?blocked=${error.groupId}`);
      }
      if (error instanceof DuplicateGroupHandleError) {
        return redirect("/app/customers/groups?error=duplicate");
      }
      throw error;
    }

    throw new Response("Unknown intent", { status: 400 });
  });

export default function CustomerGroups() {
  const { view } = useLoaderData<typeof loader>();
  return <GroupListPage view={view as GroupListView} />;
}

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { ApplicationsPage } from "~/components/customers/ApplicationsPage";
import type { ApplicationsView } from "~/components/customers/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { aiGate } from "~/lib/ai/permissions.server";
import { draftEmail } from "~/lib/ai/prompts/email-draft.server";
import { canSendEmail } from "~/lib/email/send.server";
import { isRejectionReason, REJECTION_REASONS } from "~/lib/forms/approval";
import {
  AlreadyDecidedError,
  approveSubmission,
  rejectSubmission,
  requestMoreInformation,
  undoApproval,
  UndoWindowClosedError,
} from "~/lib/forms/decisions.server";
import { readEmails } from "~/lib/forms/merge-tags";
import {
  APPLICATIONS_PAGE_SIZE,
  getApplication,
  listApplications,
} from "~/lib/forms/queue.server";
import { publicUrlFor } from "~/lib/forms/urls.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

const DAY_MS = 86_400_000;

/** The stored verdict, as the screen's five distinct sentences. */
const SCREENING_STATUS = {
  WAITING: "waiting",
  RECOMMEND: "recommend",
  LOOK: "look",
  UNAVAILABLE: "unavailable",
  OFF: "off",
} as const satisfies Record<
  string,
  ApplicationsView["rows"][number]["screening"]["status"]
>;

async function buildView(request: Request): Promise<ApplicationsView> {
  const url = new URL(request.url);
  const t = await getFixedT(detectLocale(request));
  const now = new Date();

  const page = await listApplications({
    search: url.searchParams.get("search") ?? undefined,
    page: Number(url.searchParams.get("page") ?? 1) || 1,
  });

  const [groups, liveForm] = await Promise.all([
    db.customerGroup.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, netTermsDays: true },
    }),
    db.registrationForm.findFirst({
      where: { status: "LIVE", archivedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { publicId: true },
    }),
  ]);

  const undoId = url.searchParams.get("undo");
  const undone = undoId
    ? await db.formSubmission.findUnique({ where: { id: undoId } })
    : null;

  const editId = url.searchParams.get("edit");
  const editIntent = url.searchParams.get("intent");
  const editing =
    editId && (editIntent === "approve" || editIntent === "reject")
      ? await getApplication(editId)
      : null;
  const templates = editing ? readEmails(editing.form.emails) : null;
  const panelIntent =
    editIntent === "approve" || editIntent === "reject" ? editIntent : null;
  const template =
    templates && panelIntent
      ? templates[panelIntent === "approve" ? "approved" : "rejected"]
      : null;

  // ✦ Drafting happens on a link the merchant followed, not on the way to a
  // send: nothing leaves this request. A draft that fails opens the merchant's
  // own template with a line saying the draft did not come.
  const draft =
    editing && template && panelIntent && url.searchParams.get("draft") === "1"
      ? await draftEmail({
          intent: panelIntent,
          template,
          shopName: shopScope.require("draft email"),
          formName: editing.form.name,
          groupName: null,
          // Left to the {{reason}} merge tag. The merchant picks the reason in
          // the panel under the draft and it is filled in at send time, so one
          // draft reads correctly whichever reason they choose.
          reason: null,
          note: null,
          locale: detectLocale(request),
        })
      : null;

  const view: ApplicationsView = {
    rows: page.rows.map((row) => ({
      id: row.id,
      company: row.company,
      contact: row.contact,
      email: row.email,
      formName: row.formName,
      daysAgo: Math.max(
        0,
        Math.floor((now.getTime() - row.submittedAt.getTime()) / DAY_MS),
      ),
      submittedAt: row.submittedAt.toISOString(),
      vatStatus: row.vatStatus as ApplicationsView["rows"][number]["vatStatus"],
      vatNote: row.vatNote,
      uploads: row.uploads,
      // Null when the merchant has set no criteria: there is no verdict to
      // show, and inventing one would be worse than showing nothing.
      criteria: row.verdict.notEvaluated
        ? null
        : { met: row.verdict.decision === "approve", reasons: row.verdict.reasons },
      sameDomainCount: row.sameDomainCount,
      existingCustomer: row.existingCustomer,
      screening: {
        status: SCREENING_STATUS[row.screening],
        reasons: row.screeningReasons,
      },
    })),
    total: page.total,
    page: page.page,
    pageSize: APPLICATIONS_PAGE_SIZE,
    totalWaiting: page.totalWaiting,
    search: url.searchParams.get("search") ?? "",
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      terms:
        group.netTermsDays == null
          ? null
          : t("customers.terms.net", { count: group.netTermsDays }),
    })),
    shareUrl: liveForm ? publicUrlFor(request, liveForm.publicId) : null,
    loading: false,
    undo:
      undone && undone.undoableUntil && undone.undoableUntil > now
        ? {
            id: undone.id,
            who: undone.company ?? undone.email,
            secondsLeft: Math.max(
              1,
              Math.ceil((undone.undoableUntil.getTime() - now.getTime()) / 1000),
            ),
          }
        : null,
    undoExpired: url.searchParams.get("undo_expired") === "1",
    editing:
      editing && template && panelIntent
        ? {
            id: editing.id,
            intent: panelIntent,
            subject: draft?.ok ? draft.value.subject : template.subject,
            body: draft?.ok ? draft.value.body : template.body,
            reason: "",
            note: "",
          }
        : null,
    rejectionReasons: [...REJECTION_REASONS],
    aiScreening: (await aiGate("screen")).allowed,
    emailDraft: {
      drafted: draft?.ok === true,
      failure: draft && !draft.ok ? draft.reason : null,
    },
    emailUnavailable: !canSendEmail(),
  };

  return view;
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => json({ view: await buildView(request) }));

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const id = (form.get("id") ?? "").toString();
    const actor = { type: "STAFF" as const, id: session.id };

    if (!id) throw new Response("Missing application", { status: 400 });

    const custom =
      form.get("customEmail") === "yes"
        ? {
            subject: (form.get("emailSubject") ?? "").toString(),
            body: (form.get("emailBody") ?? "").toString(),
          }
        : null;

    try {
      if (intent === "approve") {
        const groupId = (form.get("groupId") ?? "").toString();
        await approveSubmission(
          id,
          { groupId: groupId || null, email: custom },
          { admin, actor },
        );
        return redirect(`/app/customers/applications?undo=${id}`);
      }

      if (intent === "reject") {
        const reason = (form.get("reason") ?? "").toString();
        if (!isRejectionReason(reason)) {
          throw new Response("A rejection needs a reason", { status: 400 });
        }
        await rejectSubmission(
          id,
          {
            reason,
            note: (form.get("note") ?? "").toString(),
            blockDomain: form.get("blockDomain") === "yes",
            email: custom,
          },
          { admin, actor },
        );
        return redirect("/app/customers/applications");
      }

      if (intent === "needsInfo") {
        await requestMoreInformation(id, (form.get("note") ?? "").toString(), actor);
        return redirect("/app/customers/applications");
      }

      if (intent === "undo") {
        await undoApproval(id, { admin, actor });
        return redirect("/app/customers/applications");
      }
    } catch (error) {
      if (error instanceof UndoWindowClosedError) {
        return redirect("/app/customers/applications?undo_expired=1");
      }
      // Two people working the queue at once: the second one is told it was
      // already decided rather than being allowed to decide it twice.
      if (error instanceof AlreadyDecidedError) {
        return redirect("/app/customers/applications");
      }
      throw error;
    }

    throw new Response("Unknown intent", { status: 400 });
  });

export default function Applications() {
  // The action's view wins: a drafted email lives only in the action's answer,
  // and the loader — which re-runs after it — knows nothing about it.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <ApplicationsPage view={view as ApplicationsView} />;
}

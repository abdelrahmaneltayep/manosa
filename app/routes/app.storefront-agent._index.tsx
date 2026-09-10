import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { GuardrailsPage } from "~/components/agent/GuardrailsPage";
import type { GuardrailsView } from "~/components/agent/types";
import { db } from "~/db.server";
import {
  GuardrailValidationError,
  loadGuardrails,
  saveGuardrails,
} from "~/lib/agent/buyer/guardrails.server";
import {
  markGuardrailsReviewed,
  NotReadyError,
  publishAgent,
  publishReadiness,
  unpublishAgent,
} from "~/lib/agent/buyer/publish.server";
import { guardrailsView } from "~/lib/agent/buyer/view-model.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { withAdmin } from "~/shopify.server";

/**
 * The guardrails panel, and the publish flow.
 *
 * Everything the merchant decides about the Buyer Agent is here, including
 * whether it is live: the switches and the "is it on" belong in one field of
 * view, because they are one decision.
 */

const PAGE = "/app/storefront-agent";

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);

    const [guardrails, readiness, entitlements, conversations] = await Promise.all([
      loadGuardrails(),
      publishReadiness(),
      loadEntitlements(),
      db.agentConversation.count(),
    ]);

    const entitled = hasFeature(entitlements, "buyer_agent");

    return json({
      view: guardrailsView(guardrails, readiness, {
        entitled,
        requiredPlan: entitled ? null : lowestPlanWithFeature("buyer_agent"),
        conversations,
        saved: url.searchParams.get("saved") === "1",
        justPublished: url.searchParams.get("published") === "1",
        refused: url.searchParams.getAll("refused"),
        error:
          url.searchParams.get("error") === "instructions"
            ? { field: "customInstructions", code: "too_long" }
            : null,
      }),
    });
  });

/** An unchecked box submits nothing at all, so absence is "off". */
const checked = (form: FormData, name: string) => form.get(name) !== null;

const lines = (value: FormDataEntryValue | null) =>
  (value ?? "")
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const form = await request.formData();
    const intent = form.get("intent");
    const actorId = session.id;

    if (intent === "save") {
      try {
        await saveGuardrails(
          {
            canBuildCart: checked(form, "canBuildCart"),
            canRequestQuote: checked(form, "canRequestQuote"),
            canReadOrders: checked(form, "canReadOrders"),
            canReadTerms: checked(form, "canReadTerms"),
            guestMode: checked(form, "guestMode"),
            tone: (form.get("tone") ?? "warm").toString(),
            customInstructions: (form.get("customInstructions") ?? "").toString(),
            offLimits: lines(form.get("offLimits")),
          },
          actorId,
        );
      } catch (error) {
        if (error instanceof GuardrailValidationError) {
          return redirect(`${PAGE}?error=instructions`);
        }
        throw error;
      }
      return redirect(`${PAGE}?saved=1`);
    }

    if (intent === "review") {
      await markGuardrailsReviewed(actorId);
      return redirect(`${PAGE}?saved=1`);
    }

    if (intent === "publish") {
      try {
        await publishAgent(actorId);
      } catch (error) {
        // The checklist is the gate, not the disabled button: this is what a
        // merchant who reached the action with an item outstanding sees.
        if (error instanceof NotReadyError) {
          const params = new URLSearchParams();
          for (const step of error.outstanding) params.append("refused", step);
          return redirect(`${PAGE}?${params.toString()}`);
        }
        throw error;
      }
      return redirect(`${PAGE}?published=1`);
    }

    if (intent === "unpublish") {
      await unpublishAgent(actorId);
      return redirect(PAGE);
    }

    throw new Response("Unknown intent", { status: 400 });
  });

export default function StorefrontAgentGuardrails() {
  const { view } = useLoaderData<typeof loader>();
  return <GuardrailsPage view={view as GuardrailsView} />;
}

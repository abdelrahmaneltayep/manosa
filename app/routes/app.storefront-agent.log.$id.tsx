import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { TranscriptPage } from "~/components/agent/TranscriptPage";
import type { TranscriptView } from "~/components/agent/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import {
  readConversation,
  replyAsMerchant,
  takeOver,
} from "~/lib/agent/buyer/log.server";
import { transcriptView } from "~/lib/agent/buyer/view-model.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { withAdmin } from "~/shopify.server";

/**
 * One conversation, and the two ways a person joins it.
 *
 * The id is read inside the tenant scope, so another shop's conversation is
 * not found rather than refused — the difference between a 404 and a 403 is
 * the difference between "no such thing" and "yes, but not for you".
 */

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const locale = detectLocale(request);
    const t = await getFixedT(locale);
    const url = new URL(request.url);

    const [transcript, entitlements] = await Promise.all([
      readConversation(params.id ?? ""),
      loadEntitlements(),
    ]);

    if (!transcript) throw new Response("Not found", { status: 404 });

    return json({
      view: transcriptView(transcript, {
        now: new Date(),
        locale,
        t: translate(t),
        entitled: hasFeature(entitlements, "buyer_agent"),
        sent: url.searchParams.get("sent") === "1",
      }),
    });
  });

export const action = ({ request, params }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const id = params.id ?? "";
    const form = await request.formData();
    const intent = form.get("intent");
    const here = `/app/storefront-agent/log/${id}`;

    if (intent === "takeOver") {
      await takeOver(id, session.id);
      return redirect(here);
    }

    if (intent === "reply") {
      const text = (form.get("text") ?? "").toString();
      // An empty box is a slip, not an error worth a red banner: nothing is
      // sent and the merchant is back where they were.
      if (text.trim() === "") return redirect(here);

      await replyAsMerchant(id, text, session.id);
      return redirect(`${here}?sent=1`);
    }

    throw new Response("Unknown intent", { status: 400 });
  });

export default function Transcript() {
  const { view } = useLoaderData<typeof loader>();
  return <TranscriptPage view={view as TranscriptView} />;
}

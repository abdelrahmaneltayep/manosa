import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { HomePage } from "~/components/home/HomePage";
import type { HomeView } from "~/components/home/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { routeAsk } from "~/lib/ai/prompts/ask.server";
import { answerAsk } from "~/lib/agent/ask.server";
import { muteKind, unmuteKind } from "~/lib/agent/briefing.server";
import { confirmEmbed, dismissSetup, reopenSetup } from "~/lib/setup/checklist.server";
import { buildView } from "~/lib/agent/home-view.server";
import { ensureBriefingScheduled } from "~/lib/jobs/handlers/daily-briefing.server";
import { withAdmin } from "~/shopify.server";

/**
 * Home.
 *
 * Two ✦ surfaces, and one rule they share: nothing here decides anything. The
 * briefing renders figures this request computed against a list of kinds the
 * agent chose this morning; the Ask bar routes a question to a read and hands
 * back a link. The KPI cards, setup checklist and recent activity are 4.5.
 */

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    // Self-healing: a shop that installed before the briefing job existed, or
    // whose schedule lapsed, gets one queued the first time anybody opens Home.
    // Idempotent — it does nothing when one is already pending.
    await ensureBriefingScheduled();
    return json({ view: await buildView(request) });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));

    if (intent === "mute") {
      await muteKind((form.get("kind") ?? "").toString(), session.id);
      // Back to the page without the `confirm` query string, so a reload does
      // not re-ask a question the merchant has already answered.
      return redirect("/app");
    }

    if (intent === "unmute") {
      await unmuteKind((form.get("kind") ?? "").toString(), session.id);
      return redirect("/app");
    }

    if (intent === "dismissSetup") {
      await dismissSetup();
      return redirect("/app");
    }

    if (intent === "reopenSetup") {
      await reopenSetup();
      return redirect("/app");
    }

    if (intent === "confirmEmbed") {
      await confirmEmbed();
      return redirect("/app");
    }

    if (intent !== "ask") throw new Response("Unknown intent", { status: 400 });

    const question = (form.get("question") ?? "").toString().trim();
    if (!question) {
      return json(
        { view: await buildView(request, { failure: "empty" }) },
        { status: 422 },
      );
    }

    const routed = await routeAsk(question, { locale, actorId: session.id });

    if (!routed.ok) {
      return json({
        view: await buildView(request, {
          question,
          failure: routed.reason,
          // Null on purpose. Nothing in the wrapper reads a `Retry-After`, so
          // any number here would be one the app made up and told the merchant.
          // The copy says "in a moment" instead — see DECISIONS.md.
          cooldownSeconds: null,
        }),
      });
    }

    // Everything from here is our own query, in this shop's scope. There is no
    // intent that writes — see docs/adr/0021.
    const result = await answerAsk(routed.value, { locale, t });

    return json({
      view: await buildView(request, {
        question,
        result: {
          headline: t(result.headline.key, result.headline.params),
          rows: result.rows,
          href: result.href,
          isBuilder: result.isBuilder,
        },
      }),
    });
  });

export default function Home() {
  // The action's view wins: an answer lives only in its reply.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <HomePage view={view as HomeView} />;
}

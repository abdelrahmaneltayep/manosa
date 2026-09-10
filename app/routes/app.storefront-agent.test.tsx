import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { TestPage } from "~/components/agent/TestPage";
import type { TestView } from "~/components/agent/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { closeRehearsal, rehearsalView } from "~/lib/agent/buyer/rehearsal.server";
import { answerBuyerTurn } from "~/lib/agent/buyer/turn.server";
import { isAiAvailable } from "~/lib/ai/client.server";
import { MAX_MESSAGE_CHARS } from "~/lib/ai/prompts/buyer-agent.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { withAdmin } from "~/shopify.server";

/**
 * Test mode: the merchant chats as one of their own buyers.
 *
 * Against that buyer's real context — their tags, their group, their rules,
 * their terms — because a rehearsal against an invented buyer proves nothing
 * about the prices this agent will quote. Two things differ from the
 * storefront and both are named on the screen: an unpublished agent answers,
 * and every tool that writes is skipped.
 */

const requiredPlan = (entitled: boolean) =>
  entitled ? null : lowestPlanWithFeature("buyer_agent");

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const t = translate(await getFixedT(detectLocale(request)));
    const entitlements = await loadEntitlements();
    const entitled = hasFeature(entitlements, "buyer_agent");

    return json({
      view: await rehearsalView({
        t,
        entitled,
        requiredPlan: requiredPlan(entitled),
        buyerId: url.searchParams.get("buyer"),
        search: url.searchParams.get("search"),
        hasKey: isAiAvailable(),
      }),
    });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin }) => {
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));
    const form = await request.formData();
    const intent = form.get("intent");
    const asked = (form.get("buyer") ?? "").toString() || null;

    const entitlements = await loadEntitlements();
    const entitled = hasFeature(entitlements, "buyer_agent");

    // Server-side, like every other gate in this app: a disabled button is a
    // courtesy, not enforcement.
    if (!entitled) {
      return json({
        view: await rehearsalView({
          t,
          entitled,
          requiredPlan: requiredPlan(entitled),
          buyerId: asked,
          hasKey: isAiAvailable(),
        }),
      });
    }

    if (intent === "restart") {
      if (asked) await closeRehearsal(asked);
      return json({
        view: await rehearsalView({
          t,
          entitled,
          requiredPlan: requiredPlan(entitled),
          buyerId: asked,
          hasKey: isAiAvailable(),
        }),
      });
    }

    if (intent !== "say") throw new Response("Unknown intent", { status: 400 });

    const message = (form.get("message") ?? "").toString().slice(0, MAX_MESSAGE_CHARS);

    // Which buyer this is has to be one of *this shop's* approved buyers, and
    // the view model is what decides that — a customer id in a form field is
    // not proof of anything, and this screen reads terms and order history.
    const before = await rehearsalView({
      t,
      entitled,
      requiredPlan: null,
      buyerId: asked,
      hasKey: isAiAvailable(),
    });

    if (!before.buyerId || message.trim() === "") return json({ view: before });

    const turn = await answerBuyerTurn({
      message,
      customerId: before.buyerId,
      locale,
      admin,
      testMode: true,
    });

    return json({
      view: await rehearsalView({
        t,
        entitled,
        requiredPlan: null,
        buyerId: before.buyerId,
        hasKey: isAiAvailable(),
        cart: turn.cart,
        failure: turn.failure,
      }),
    });
  });

export default function StorefrontAgentTest() {
  // A non-redirect action re-runs the loader, so the action's view is the
  // fresher of the two whenever there is one.
  const answered = useActionData<typeof action>();
  const { view } = useLoaderData<typeof loader>();
  return <TestPage view={(answered?.view ?? view) as TestView} />;
}

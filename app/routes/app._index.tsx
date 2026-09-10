import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { HomePage } from "~/components/home/HomePage";
import type { BriefingItemView, HomeView } from "~/components/home/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate, type Translate } from "~/i18n/translate";
import { isAiAvailable } from "~/lib/ai/client.server";
import { routeAsk } from "~/lib/ai/prompts/ask.server";
import { answerAsk } from "~/lib/agent/ask.server";
import {
  latestBriefing,
  linesFor,
  muteKind,
  mutedKinds,
  STALE_AFTER_MS,
} from "~/lib/agent/briefing.server";
import { briefingFacts, type AgentFact } from "~/lib/agent/facts.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { formatCurrency } from "~/lib/money";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

/**
 * Home.
 *
 * Two ✦ surfaces, and one rule they share: nothing here decides anything. The
 * briefing renders figures this request computed against a list of kinds the
 * agent chose this morning; the Ask bar routes a question to a read and hands
 * back a link. The KPI cards, setup checklist and recent activity are 4.5.
 */

const ASK_EXAMPLES = ["home.ask.example1", "home.ask.example2", "home.ask.example3"];
const REFORMULATIONS = [
  "home.ask.reformulation1",
  "home.ask.reformulation2",
  "home.ask.reformulation3",
];

/** The action button on each briefing item. One per kind, no default. */
const ACTION_KEYS: Record<string, string> = {
  applications_waiting: "home.briefing.action.review",
  screening_flagged: "home.briefing.action.review",
  invoices_overdue: "home.briefing.action.chase",
  credit_exceeded: "home.briefing.action.review",
  quotes_expiring: "home.briefing.action.chase",
  orders_needing_resync: "home.briefing.action.open",
  rules_unused: "home.briefing.action.open",
  no_active_rules: "home.briefing.action.createRule",
  buyers_gone_quiet: "home.briefing.action.open",
  wholesale_week: "home.briefing.action.open",
  form_never_opened: "home.briefing.action.share",
  uploads_unscanned: "home.briefing.action.review",
};

/** The figure beside each line, in the merchant's own currency and language. */
function figureFor(fact: AgentFact, t: Translate, locale: string): string {
  if (fact.amount) {
    return t(`home.briefing.figure.${fact.kind}Amount`, {
      count: fact.count,
      amount: formatCurrency(fact.amount, locale),
    });
  }
  return t(`home.briefing.figure.${fact.kind}`, {
    count: fact.count,
    subject: fact.subject ?? "",
  });
}

async function buildView(
  request: Request,
  overrides: Partial<HomeView["ask"]> = {},
): Promise<HomeView> {
  const locale = detectLocale(request);
  const t = translate(await getFixedT(locale));
  const now = new Date();

  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("home") },
  });
  const entitlements = await loadEntitlements(now);
  const agentAvailable = isAiAvailable() && hasFeature(entitlements, "merchant_agent");

  const [briefing, facts, muted] = await Promise.all([
    latestBriefing(),
    briefingFacts(now),
    mutedKinds(),
  ]);

  const visible = facts.filter((fact) => !muted.includes(fact.kind));
  const lines = linesFor(briefing, visible);

  const items: BriefingItemView[] = lines.map((line) => ({
    kind: line.item.kind,
    reason: line.item.reason,
    figure: figureFor(line.fact, t, locale),
    href: line.fact.href,
    actionKey: ACTION_KEYS[line.item.kind] ?? "home.briefing.action.open",
  }));

  const stale =
    briefing !== null && now.getTime() - briefing.generatedAt.getTime() > STALE_AFTER_MS;

  return {
    shopName: shop?.name ?? shopScope.require("home"),
    briefing: {
      status: !agentAvailable
        ? "off"
        : briefing === null
          ? "empty"
          : items.length === 0
            ? "quiet"
            : "ready",
      items,
      writtenAt: briefing ? briefing.generatedAt.toISOString() : null,
      stale,
      muted,
    },
    ask: {
      available: agentAvailable,
      question: "",
      examples: ASK_EXAMPLES.map((key) => t(key)),
      result: null,
      failure: null,
      reformulations: REFORMULATIONS.map((key) => t(key)),
      cooldownSeconds: null,
      ...overrides,
    },
  };
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => json({ view: await buildView(request) }));

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));

    if (intent === "mute") {
      await muteKind((form.get("kind") ?? "").toString(), session.id);
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
          // A cooldown the merchant can act on: the wrapper waited once
          // already, so this is how long before it is worth trying again.
          cooldownSeconds: routed.reason === "rate_limited" ? 30 : null,
        }),
      });
    }

    // Everything from here is our own query, in this shop's scope. There is no
    // intent that writes — see docs/adr/0021.
    const result = await answerAsk(routed.value, { locale });

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

import type { BriefingItemView, BriefingView, HomeView } from "~/components/home/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate, type Translate } from "~/i18n/translate";
import { isAiAvailable } from "~/lib/ai/client.server";
import {
  briefingFailure,
  latestBriefing,
  linesFor,
  mutedKinds,
  STALE_AFTER_MS,
} from "~/lib/agent/briefing.server";
import { briefingFacts, isFactKind, type AgentFact } from "~/lib/agent/facts.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { formatCurrency } from "~/lib/money";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The home page as data.
 *
 * Its own module rather than the route's, because everything interesting about
 * Home is in here — which of the six briefing cards is true, what number goes
 * beside each item, whether the agent is on — and none of it should need an
 * authenticated Shopify request to test.
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

/**
 * Which of the six cards to show.
 *
 * The distinction that matters is between "the agent looked and found nothing"
 * and "the agent could not be reached". `MerchantBriefing.quiet` records the
 * first; a recorded failure newer than the last briefing records the second.
 * Reading `items.length === 0` for both told a merchant "All quiet — nothing
 * needs you today" while six applications were waiting.
 */
export function briefingStatus(input: {
  agentAvailable: boolean;
  briefing: unknown | null;
  failure: string | null;
  shown: number;
  /** Facts that are true right now and not muted. */
  outstanding: number;
}): BriefingView["status"] {
  if (!input.agentAvailable) return "off";
  // A failure since the last briefing: today's could not be written, and what
  // is on screen — if anything — is the previous one.
  if (input.failure) return "unavailable";
  if (!input.briefing) return "empty";
  if (input.shown > 0) return "ready";
  // Nothing on the list, and nothing outstanding either: genuinely quiet.
  if (input.outstanding === 0) return "quiet";
  // The list is dealt with, but other things have come up since it was
  // written. Saying "All quiet" here is the lie: six applications can arrive
  // after a briefing about overdue invoices the merchant has since paid.
  return "cleared";
}

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

export async function buildView(
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
  const failure = await briefingFailure(briefing);

  const visible = facts.filter((fact) => !muted.includes(fact.kind));
  const lines = linesFor(briefing, visible);

  // A shop that has downgraded off the agent, or lost its key, sees the
  // "switched off" card and nothing under it — not yesterday's ✦ items with
  // the model's prose still on them.
  const items: BriefingItemView[] = agentAvailable
    ? lines.map((line) => ({
        kind: line.item.kind,
        reason: line.item.reason,
        figure: figureFor(line.fact, t, locale),
        href: line.fact.href,
        actionKey: ACTION_KEYS[line.item.kind] ?? "home.briefing.action.open",
      }))
    : [];

  const stale =
    briefing !== null && now.getTime() - briefing.generatedAt.getTime() > STALE_AFTER_MS;

  // "Not this again" links here rather than posting, so that the question is
  // asked without anything having been written yet. An unknown kind in the
  // query string asks nothing — it does not render a raw string as a heading.
  const asked = new URL(request.url).searchParams.get("confirm");
  const confirmingMute = asked !== null && isFactKind(asked) ? asked : null;

  return {
    shopName: shop?.name ?? shopScope.require("home"),
    briefing: {
      status: briefingStatus({
        agentAvailable,
        briefing,
        failure,
        shown: items.length,
        outstanding: visible.length,
      }),
      items,
      writtenAt: briefing ? briefing.generatedAt.toISOString() : null,
      writtenAtLabel: briefing
        ? new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
            briefing.generatedAt,
          )
        : null,
      stale,
      muted: muted.map((kind) => ({
        kind,
        label: t(`home.briefing.mutedKind.${kind}`),
      })),
      confirmingMute,
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

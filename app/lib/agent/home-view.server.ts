import type { BriefingItemView, BriefingView, HomeView } from "~/components/home/types";
import { db } from "~/db.server";
import {
  loadActivity,
  RELATIVE_WINDOW_MS,
  type ActivityRow,
} from "~/lib/activity/feed.server";
import {
  deltaPercent,
  loadKpis,
  PERIODS,
  DEFAULT_PERIOD,
  isPeriod,
  type KpiSet,
  type KpiValue,
  type Period,
} from "~/lib/analytics/kpis.server";
import { loadSetup } from "~/lib/setup/checklist.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate, type Translate } from "~/i18n/translate";
import { aiGate } from "~/lib/ai/permissions.server";
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
  const agentAvailable =
    (await aiGate("draft")).allowed && hasFeature(entitlements, "merchant_agent");

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("period"));
  const period: Period = isPeriod(requested) ? requested : DEFAULT_PERIOD;

  const [briefing, facts, muted, kpis, setup, activity, wholesaleOrders] =
    await Promise.all([
      latestBriefing(),
      briefingFacts(now),
      mutedKinds(),
      loadKpis(period, { now }),
      loadSetup(),
      loadActivity(),
      db.order.count({ where: { isWholesale: true } }),
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
  const asked = url.searchParams.get("confirm");
  const confirmingMute = asked !== null && isFactKind(asked) ? asked : null;

  return {
    shopName: shop?.name ?? shopScope.require("home"),
    kpis: kpiView(kpis, { locale, empty: wholesaleOrders === 0 }),
    setup: {
      items: setup.items.map((item) => ({
        step: item.step,
        done: item.done,
        href: item.href,
        attested: item.attested ?? false,
      })),
      done: setup.done,
      total: setup.total,
      complete: setup.complete,
      dismissed: setup.dismissed,
    },
    activity: activityView(activity, { now, locale, t }),
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

/* -------------------------------------------------------------------------- */

/**
 * Relative inside a week, absolute after it.
 *
 * The checklist's rule, and the right one: "3 days ago" is how a person thinks
 * about this week and a useless way to describe last March.
 */
export function whenLabel(at: Date, now: Date, locale: string): string {
  const elapsed = now.getTime() - at.getTime();

  if (elapsed < RELATIVE_WINDOW_MS) {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const minutes = Math.round(elapsed / 60_000);
    if (minutes < 60) return relative.format(-minutes, "minute");
    const hours = Math.round(elapsed / 3_600_000);
    if (hours < 24) return relative.format(-hours, "hour");
    return relative.format(-Math.round(elapsed / 86_400_000), "day");
  }

  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
}

/** The kind chip: the family of thing this row is, in one word. */
export function activityKindLabel(action: string, t: Translate): string {
  const family = action.split(".")[0] ?? "other";
  const known = [
    "order",
    "pricing_rule",
    "pricing",
    "form",
    "customer",
    "customer_group",
    "customer_tag_rule",
    "customer_segment",
    "quote",
    "draft_order",
    "terms",
    "billing",
    "briefing",
    "setup",
    "app",
    "shop",
  ];
  return t(
    known.includes(family) ? `home.activity.kind.${family}` : "home.activity.kind.other",
  );
}

export function activityView(
  page: { rows: ActivityRow[] },
  options: { now: Date; locale: string; t: Translate },
): HomeView["activity"] {
  return {
    rows: page.rows.map((row) => ({
      id: row.id,
      summary: row.summary,
      when: whenLabel(row.at, options.now, options.locale),
      at: row.at.toISOString(),
      href: row.href,
      agent: row.agent,
      kindLabel: activityKindLabel(row.action, options.t),
    })),
    href: "/app/activity",
    empty: page.rows.length === 0,
  };
}

/** The five cards, formatted. Nothing downstream does arithmetic. */
export function kpiView(
  set: KpiSet,
  options: { locale: string; empty: boolean },
): HomeView["kpis"] {
  const format = (value: KpiValue["value"]) =>
    typeof value === "number"
      ? new Intl.NumberFormat(options.locale).format(value)
      : formatCurrency(value, options.locale);

  return {
    period: set.period,
    periods: [...PERIODS],
    empty: options.empty,
    // Only when it is short: a fully covered period needs no caveat.
    coversDays: set.historyDays < set.period ? set.historyDays : null,
    cards: set.kpis.map((kpi) => ({
      key: kpi.key,
      value: format(kpi.value.value),
      previous: kpi.value.previous === null ? null : format(kpi.value.previous),
      deltaPercent: deltaPercent(
        amountOf(kpi.value.value),
        kpi.value.previous === null ? null : amountOf(kpi.value.previous),
      ),
      partial: kpi.partial,
      href: kpi.href,
    })),
  };
}

const amountOf = (value: KpiValue["value"]) =>
  typeof value === "number" ? value : value.amount;

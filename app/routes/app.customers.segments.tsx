import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { SegmentsPage } from "~/components/customers/SegmentsPage";
import type { SegmentDraftView, SegmentsView } from "~/components/customers/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate, type Translate } from "~/i18n/translate";
import { aiGate, requireAi } from "~/lib/ai/permissions.server";
import {
  draftSegment,
  resolveSegment,
  type NamedSegment,
  type SegmentGrounding,
} from "~/lib/ai/prompts/segment.server";
import { describeCondition } from "~/lib/customers/segments-view.server";
import { readConditions, type SegmentCondition } from "~/lib/customers/segments";
import {
  deleteSegment,
  listSegments,
  previewSegment,
  saveSegment,
  SegmentValidationError,
} from "~/lib/customers/segments.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

/**
 * ✦ Segment builder.
 *
 * A sentence becomes chips; the chips become a count; the count becomes a saved
 * filter. Every step is re-derived from the same payload on the server, so what
 * gets saved is what the merchant was looking at — and a chip they removed is
 * gone from the query, not just from the screen.
 *
 * Nothing here prices anything. A saved segment is a filter; turning one into a
 * pricing rule's audience is the rule builder's job, and goes through
 * `createRule` with an audit entry like every other rule.
 */

const EXAMPLE_KEYS = ["segments.example1", "segments.example2", "segments.example3"];

interface DraftEnvelope {
  sentence: string;
  name: string;
  conditions: SegmentCondition[];
  notes: string | null;
  choices: Record<string, string>;
  /** Which model read the sentence, for the audit entry on save. */
  model: string;
  promptVersion: string;
}

function encode(envelope: DraftEnvelope): string {
  return JSON.stringify(envelope);
}

/** Read a draft back. Null for anything unreadable — never a throw. */
function decode(raw: string | null): DraftEnvelope | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as Partial<DraftEnvelope>;
    if (typeof envelope.sentence !== "string") return null;

    const choices: Record<string, string> = {};
    for (const [term, id] of Object.entries(envelope.choices ?? {})) {
      if (typeof id === "string" && id !== "") choices[term] = id;
    }

    if (typeof envelope.model !== "string" || envelope.model === "") return null;

    return {
      sentence: envelope.sentence,
      name: typeof envelope.name === "string" ? envelope.name : "",
      // The same reader the database and the model's answer go through.
      conditions: readConditions(envelope.conditions),
      notes: typeof envelope.notes === "string" ? envelope.notes : null,
      choices,
      model: envelope.model,
      promptVersion: String(envelope.promptVersion ?? ""),
    };
  } catch {
    return null;
  }
}

async function grounding(): Promise<SegmentGrounding> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("segments") },
  });
  const [groups, customers] = await Promise.all([
    db.customerGroup.findMany({
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    db.customer.findMany({ select: { tags: true }, take: 500 }),
  ]);

  const tags = new Set<string>();
  for (const row of customers) {
    for (const tag of row.tags) if (tags.size < 40) tags.add(tag);
  }

  return {
    currencyCode: shop?.currencyCode ?? "USD",
    groups,
    tags: [...tags].sort(),
  };
}

async function savedList() {
  const rows = await listSegments();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    conditionCount: readConditions(row.conditions).length,
    lastCount: row.lastCount,
    lastCountAt: row.lastCountAt ? row.lastCountAt.toISOString() : null,
    fromSentence: row.sentence !== null,
  }));
}

async function baseView(request: Request): Promise<SegmentsView> {
  const t = translate(await getFixedT(detectLocale(request)));

  return {
    aiAvailable: (await aiGate("draft")).allowed,
    sentence: "",
    examples: EXAMPLE_KEYS.map((key) => t(key)),
    failure: null,
    draft: null,
    saveError: null,
    saved: await savedList(),
  };
}

/**
 * Chips, count and questions for one draft.
 *
 * The count is run only when nothing is still a question: counting a segment
 * whose group condition was dropped would report on a filter the merchant never
 * asked for, and the number would be wrong in the reassuring direction.
 */
async function draftView(
  envelope: DraftEnvelope,
  ground: SegmentGrounding,
  t: Translate,
  locale: string,
  now: Date,
): Promise<SegmentDraftView> {
  const named: NamedSegment = {
    name: envelope.name,
    conditions: envelope.conditions,
    notes: envelope.notes,
  };
  const resolved = resolveSegment(named, ground, envelope.choices);
  const groupNames = new Map(ground.groups.map((group) => [group.id, group.name]));

  const preview =
    resolved.clarifications.length === 0
      ? await previewSegment(resolved.conditions, now)
      : null;

  return {
    name: resolved.name,
    chips: resolved.conditions.map((condition, index) => ({
      index,
      label: describeCondition(condition, t, groupNames, locale),
      loosen: preview?.loosen === index,
    })),
    count: preview?.count ?? null,
    samples: preview?.samples ?? [],
    payload: encode({ ...envelope, conditions: resolved.conditions }),
    notes: resolved.notes,
    clarifications: resolved.clarifications.map((one) => ({
      index: one.index,
      term: one.term,
      options: one.options,
    })),
  };
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => json({ view: await baseView(request) }));

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));
    const now = new Date();
    const base = await baseView(request);

    if (intent === "delete") {
      await deleteSegment((form.get("id") ?? "").toString(), {
        type: "STAFF",
        id: session.id,
      });
      return redirect("/app/customers/segments");
    }

    if (intent === "draft") {
      // Enforcement, not the disabled button.
      await requireAi("draft");
      const sentence = (form.get("sentence") ?? "").toString().trim();
      if (!sentence) {
        return json({ view: { ...base, failure: "empty" as const } }, { status: 422 });
      }

      const ground = await grounding();
      const result = await draftSegment({
        sentence,
        grounding: ground,
        actorId: session.id,
      });

      if (!result.ok) {
        return json({ view: { ...base, sentence, failure: result.reason } });
      }

      const envelope: DraftEnvelope = {
        sentence,
        name: result.value.name,
        conditions: result.value.conditions,
        notes: result.value.notes,
        choices: {},
        model: result.model,
        promptVersion: result.promptVersion,
      };

      return json({
        view: {
          ...base,
          sentence,
          draft: await draftView(envelope, ground, t, locale, now),
        },
      });
    }

    const envelope = decode((form.get("draft") ?? "").toString());
    if (!envelope) {
      return json(
        { view: { ...base, failure: "invalid_output" as const } },
        { status: 422 },
      );
    }

    const ground = await grounding();

    if (intent === "remove") {
      const index = Number(form.get("index"));
      const conditions = envelope.conditions.filter((_one, at) => at !== index);
      return json({
        view: {
          ...base,
          sentence: envelope.sentence,
          draft: await draftView({ ...envelope, conditions }, ground, t, locale, now),
        },
      });
    }

    if (intent === "answer") {
      const term = (form.get("term") ?? "").toString();
      const choice = (form.get("choice") ?? "").toString();
      const answered: DraftEnvelope = {
        ...envelope,
        choices: { ...envelope.choices, ...(term && choice ? { [term]: choice } : {}) },
      };
      return json({
        view: {
          ...base,
          sentence: envelope.sentence,
          draft: await draftView(answered, ground, t, locale, now),
        },
      });
    }

    if (intent !== "save") throw new Response("Unknown intent", { status: 400 });

    const named: NamedSegment = {
      name: (form.get("name") ?? envelope.name).toString(),
      conditions: envelope.conditions,
      notes: envelope.notes,
    };
    const resolved = resolveSegment(named, ground, envelope.choices);

    if (resolved.clarifications.length > 0) {
      return json(
        {
          view: {
            ...base,
            sentence: envelope.sentence,
            draft: await draftView(envelope, ground, t, locale, now),
          },
        },
        { status: 422 },
      );
    }

    try {
      await saveSegment(
        {
          name: named.name,
          conditions: resolved.conditions,
          sentence: envelope.sentence,
          // The provenance travels with the draft. The merchant pressing save is
          // the approval `recordAudit` requires before it will record an
          // AI-assisted entry at all.
          ai: { model: envelope.model, promptVersion: envelope.promptVersion },
        },
        { type: "STAFF", id: session.id },
        now,
      );
      return redirect("/app/customers/segments");
    } catch (error) {
      const duplicate =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2002";

      if (duplicate || error instanceof SegmentValidationError) {
        return json(
          {
            view: {
              ...base,
              sentence: envelope.sentence,
              saveError: duplicate ? ("duplicate_name" as const) : ("invalid" as const),
              draft: await draftView(envelope, ground, t, locale, now),
            },
          },
          { status: 422 },
        );
      }
      throw error;
    }
  });

export default function Segments() {
  // The action's view wins: the draft lives only in its answer.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <SegmentsPage view={view as SegmentsView} />;
}

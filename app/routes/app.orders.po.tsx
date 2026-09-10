import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { PurchaseOrderPage } from "~/components/orders/PurchaseOrderPage";
import type { PoLineView, PurchaseOrderView } from "~/components/orders/types";
import { db } from "~/db.server";
import { detectLocale } from "~/i18n.server";
import { isAiAvailable } from "~/lib/ai/client.server";
import {
  MAX_PO_CHARS,
  readPurchaseOrder,
  type PoLine,
} from "~/lib/ai/prompts/purchase-order.server";
import { recordAudit } from "~/lib/audit/record.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { formatCurrency } from "~/lib/money";
import {
  matchPurchaseOrder,
  orderableLines,
  type MatchedPo,
} from "~/lib/orders/purchase-order.server";
import { createDraftOrder } from "~/lib/quotes/admin-graphql.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

/**
 * ✦ PO-to-order.
 *
 * Claude reads the lines out of the document. Everything after that is this
 * app: the catalogue matches them, the pricing engine prices them, and the
 * merchant presses the one button that creates anything.
 *
 * The document's own prices are never charged. They are carried through so the
 * screen can print the difference, which is the number a merchant actually
 * wants to see.
 */

/** A pasted or uploaded document bigger than this is not a purchase order. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface PoEnvelope {
  buyerId: string | null;
  reference: string | null;
  notes: string | null;
  lines: PoLine[];
  /** Merchant answers to ambiguous lines: line index → variant id. */
  chosen: Record<string, string>;
}

const encode = (envelope: PoEnvelope) => JSON.stringify(envelope);

function decode(raw: string): PoEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as Partial<PoEnvelope>;
    if (!Array.isArray(envelope.lines) || envelope.lines.length === 0) return null;

    const chosen: Record<string, string> = {};
    for (const [index, id] of Object.entries(envelope.chosen ?? {})) {
      if (typeof id === "string" && id !== "") chosen[index] = id;
    }

    return {
      buyerId: typeof envelope.buyerId === "string" ? envelope.buyerId : null,
      reference: typeof envelope.reference === "string" ? envelope.reference : null,
      notes: typeof envelope.notes === "string" ? envelope.notes : null,
      lines: envelope.lines as PoLine[],
      chosen,
    };
  } catch {
    return null;
  }
}

async function buyers() {
  return db.customer.findMany({
    where: { status: "APPROVED", deletedInShopifyAt: null },
    orderBy: { lifetimeSpend: "desc" },
    take: 100,
    select: {
      id: true,
      customerId: true,
      company: true,
      email: true,
      tags: true,
      groupId: true,
    },
  });
}

async function baseView(): Promise<PurchaseOrderView> {
  const entitlements = await loadEntitlements();
  const entitled = hasFeature(entitlements, "po_to_order");
  const keyed = isAiAvailable();
  const rows = await buyers();

  return {
    available: entitled && keyed,
    locked: !entitled ? "plan" : !keyed ? "no_key" : null,
    text: "",
    fileError: null,
    failure: null,
    buyer: null,
    buyers: rows.map((row) => ({
      id: row.id,
      label: row.company ?? row.email ?? row.id,
    })),
    lines: [],
    subtotal: null,
    reference: null,
    notes: null,
    needsAttention: 0,
    payload: "",
    created: null,
  };
}

function lineViews(matched: MatchedPo, locale: string): PoLineView[] {
  const fmt = (value: { amount: number; currencyCode: string } | null) =>
    value ? formatCurrency(value, locale) : null;

  return matched.lines.map((line) => ({
    index: line.index,
    requested: line.requested.sku ?? line.requested.description ?? "",
    quantity: line.requested.quantity,
    confidence: line.confidence,
    matched: line.variant?.title ?? null,
    sku: line.variant?.sku ?? null,
    unitPrice: fmt(line.unitPrice),
    lineTotal: fmt(line.lineTotal),
    statedPrice: fmt(line.statedPrice),
    priceDelta: fmt(line.priceDelta),
    ruleSummary: line.ruleSummary,
    candidates:
      line.confidence === "ambiguous"
        ? line.candidates.map((candidate) => ({
            id: candidate.id,
            label: candidate.title,
            sku: candidate.sku,
          }))
        : [],
  }));
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => json({ view: await baseView() }));

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const contentType = request.headers.get("content-type") ?? "";
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const locale = detectLocale(request);
    const base = await baseView();

    // Gated server-side. A plan that does not include PO-to-order, or a shop
    // with no key, cannot reach the model by posting to this route directly.
    if (!base.available) return json({ view: base }, { status: 402 });

    const shop = await db.shop.findUnique({
      where: { shop: shopScope.require("po") },
    });
    const currencyCode = shop?.currencyCode ?? "USD";
    const now = new Date();

    /** Match, price and render one envelope. */
    const review = async (envelope: PoEnvelope): Promise<PurchaseOrderView> => {
      const rows = await buyers();
      const buyer = envelope.buyerId
        ? (rows.find((row) => row.id === envelope.buyerId) ?? null)
        : null;

      const matched = await matchPurchaseOrder(admin, envelope.lines, {
        buyer: {
          customerId: buyer?.customerId ?? null,
          tags: buyer?.tags ?? [],
          groupIds: buyer?.groupId ? [buyer.groupId] : [],
        },
        currencyCode,
        now,
      });

      // The merchant's answers to the ambiguous lines, applied after matching
      // so what is shown is what they actually chose.
      const lines = lineViews(matched, locale).map((line) => {
        const choice = envelope.chosen[String(line.index)];
        if (!choice) return line;

        const picked = matched.lines[line.index]?.candidates.find(
          (candidate) => candidate.id === choice,
        );
        return picked
          ? {
              ...line,
              confidence: "exact" as const,
              matched: picked.title,
              sku: picked.sku,
              candidates: [],
            }
          : line;
      });

      return {
        ...base,
        buyer: buyer
          ? { id: buyer.id, label: buyer.company ?? buyer.email ?? buyer.id }
          : null,
        lines,
        subtotal:
          matched.subtotal.amount > 0 ? formatCurrency(matched.subtotal, locale) : null,
        reference: envelope.reference,
        notes: envelope.notes,
        needsAttention: lines.filter((line) => line.confidence !== "exact").length,
        payload: encode(envelope),
      };
    };

    if (intent === "read") {
      const buyerId = (form.get("buyerId") ?? "").toString() || null;
      let text = (form.get("text") ?? "").toString().trim();

      const file = form.get("file");
      if (
        contentType.includes("multipart/form-data") &&
        file instanceof File &&
        file.size > 0
      ) {
        if (file.size > MAX_FILE_BYTES) {
          return json(
            { view: { ...base, fileError: "too_large" as const } },
            { status: 422 },
          );
        }

        const content = await file.text();
        // A PDF or a spreadsheet arrives as bytes we cannot read as text. The
        // checklist's own answer: say so, and offer the textarea.
        if (!isReadableText(content)) {
          return json(
            { view: { ...base, fileError: "unreadable" as const } },
            { status: 422 },
          );
        }
        text = content.slice(0, MAX_PO_CHARS);
      }

      if (!text) {
        return json({ view: { ...base, failure: "empty" as const } }, { status: 422 });
      }

      const read = await readPurchaseOrder(text, { actorId: session.id });
      if (!read.ok) {
        return json({ view: { ...base, text, failure: read.reason } });
      }

      const envelope: PoEnvelope = {
        buyerId,
        reference: read.value.reference,
        notes: read.value.notes,
        lines: read.value.lines,
        chosen: {},
      };

      return json({ view: { ...(await review(envelope)), text } });
    }

    const envelope = decode((form.get("payload") ?? "").toString());
    if (!envelope) {
      return json(
        { view: { ...base, failure: "invalid_output" as const } },
        { status: 422 },
      );
    }

    if (intent === "choose") {
      const index = (form.get("index") ?? "").toString();
      const variantId = (form.get("variantId") ?? "").toString();

      return json({
        view: await review({
          ...envelope,
          chosen: {
            ...envelope.chosen,
            ...(index && variantId ? { [index]: variantId } : {}),
          },
        }),
      });
    }

    if (intent !== "create") throw new Response("Unknown intent", { status: 400 });

    const rows = await buyers();
    const buyer = envelope.buyerId
      ? (rows.find((row) => row.id === envelope.buyerId) ?? null)
      : null;

    // Re-matched and re-priced inside this request. The prices that go on the
    // order are this moment's, not the ones the page was showing.
    const matched = await matchPurchaseOrder(admin, envelope.lines, {
      buyer: {
        customerId: buyer?.customerId ?? null,
        tags: buyer?.tags ?? [],
        groupIds: buyer?.groupId ? [buyer.groupId] : [],
      },
      currencyCode,
      now,
    });

    const lines = orderableLines(matched);
    if (lines.length === 0) {
      return json(
        { view: { ...(await review(envelope)), failure: "empty" as const } },
        { status: 422 },
      );
    }

    const draft = await createDraftOrder(admin, {
      customerId: buyer?.customerId ?? null,
      email: buyer?.email ?? null,
      lines,
      note: envelope.reference ? `PO ${envelope.reference}` : null,
      tags: ["mannon", "mannon-po"],
    });

    await recordAudit({
      actor: { type: "STAFF", id: session.id },
      action: "draft_order.created_from_po",
      summary: `Approved a purchase order read by Claude and created the draft order ${draft.name}.`,
      subject: { type: "DraftOrder", id: draft.id },
      metadata: {
        reference: envelope.reference,
        lines: lines.length,
        unmatched: matched.lines.length - lines.length,
      },
      // Live commercial data, created on Claude's reading of a document.
      aiAssisted: true,
      approval: { byId: session.id },
    });

    return json({
      view: {
        ...(await review(envelope)),
        created: { name: draft.name, invoiceUrl: draft.invoiceUrl },
      },
    });
  });

/**
 * Is this text, or is it the bytes of a PDF?
 *
 * A cheap, honest test. A document we cannot read as text gets the checklist's
 * "Couldn't read this — paste the lines as text?" rather than twenty seconds of
 * a model staring at binary.
 */
export function isReadableText(content: string): boolean {
  if (content.startsWith("%PDF")) return false;
  // A .xlsx or .docx is a zip.
  if (content.startsWith("PK")) return false;

  const sample = content.slice(0, 2_000);
  const printable = [...sample].filter((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 || code === 9 || code === 10 || code === 13;
  }).length;

  return sample.length === 0 || printable / sample.length > 0.95;
}

export default function PurchaseOrder() {
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <PurchaseOrderPage view={view as PurchaseOrderView} />;
}

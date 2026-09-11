import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { PurchaseOrderPage } from "~/components/orders/PurchaseOrderPage";
import type { PoLineView, PurchaseOrderView } from "~/components/orders/types";
import { db } from "~/db.server";
import { detectLocale } from "~/i18n.server";
import { aiGate } from "~/lib/ai/permissions.server";
import { MAX_PO_CHARS, readPurchaseOrder } from "~/lib/ai/prompts/purchase-order.server";
import { recordAudit } from "~/lib/audit/record.server";
import { MAX_FILE_BYTES } from "~/lib/pricing/csv/import.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { formatCurrency } from "~/lib/money";
import {
  decode,
  encode,
  isReadableText,
  type PoEnvelope,
} from "~/lib/orders/po-envelope.server";
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

/** How many buyers the picker lists. A `s-select` is not a paginated list. */
const BUYER_OPTIONS = 100;

const BUYER_FIELDS = {
  id: true,
  customerId: true,
  company: true,
  email: true,
  tags: true,
  groupId: true,
} as const;

/**
 * The picker's options — and always the buyer this PO is for.
 *
 * The largest hundred fit in a select; buyer 101 does not. Resolving the
 * chosen buyer out of that same capped list is what made a shop with more
 * buyers than the cap price a purchase order as though nobody was buying it:
 * `find` returned nothing and the engine was handed an anonymous buyer.
 * So the selected one is fetched by id whenever the list does not hold it,
 * and the page says the list is not everybody.
 */
async function buyers(selectedId: string | null) {
  const where = { status: "APPROVED" as const, deletedInShopifyAt: null };
  const [total, rows] = await Promise.all([
    db.customer.count({ where }),
    db.customer.findMany({
      where,
      orderBy: { lifetimeSpend: "desc" },
      take: BUYER_OPTIONS,
      select: BUYER_FIELDS,
    }),
  ]);

  if (selectedId && !rows.some((row) => row.id === selectedId)) {
    const selected = await db.customer.findFirst({
      where: { ...where, id: selectedId },
      select: BUYER_FIELDS,
    });
    if (selected) rows.unshift(selected);
  }

  return { rows, truncated: total > BUYER_OPTIONS };
}

async function baseView(
  selectedId: string | null,
  locale: string,
): Promise<PurchaseOrderView> {
  const entitlements = await loadEntitlements();
  const entitled = hasFeature(entitlements, "po_to_order");
  const keyed = (await aiGate("draft")).allowed;
  const { rows, truncated } = await buyers(selectedId);

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
    buyersTruncated: truncated,
    // Stated, not implied: an error that says "too big" without saying how
    // big is one the merchant cannot act on.
    fileLimit: new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "megabyte",
      unitDisplay: "short",
    }).format(Math.floor(MAX_FILE_BYTES / (1024 * 1024))),
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
  withAdmin(request, async () => {
    // `?buyerId=` is how a buyer outside the picker's hundred is reached: the
    // customers list paginates, and its "raise a purchase order" link lands
    // here with that buyer already selected.
    const selected = new URL(request.url).searchParams.get("buyerId");
    return json({
      view: await baseView(selected || null, detectLocale(request)),
    });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const contentType = request.headers.get("content-type") ?? "";
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const locale = detectLocale(request);
    const base = await baseView((form.get("buyerId") ?? "").toString() || null, locale);

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
      const { rows } = await buyers(envelope.buyerId);
      const buyer = envelope.buyerId
        ? (rows.find((row) => row.id === envelope.buyerId) ?? null)
        : null;

      // `chosen` goes into the match, not over the top of it: the merchant's
      // pick has to reach the price and the order, not just the screen.
      const matched = await matchPurchaseOrder(admin, envelope.lines, {
        buyer: {
          customerId: buyer?.customerId ?? null,
          tags: buyer?.tags ?? [],
          groupIds: buyer?.groupId ? [buyer.groupId] : [],
        },
        currencyCode,
        now,
        chosen: envelope.chosen,
      });

      const lines = lineViews(matched, locale);

      return {
        ...base,
        // Rebuilt here, not taken from `base`: the buyer this PO is for has to
        // be one of the options, whether or not they are in the largest
        // hundred.
        buyers: rows.map((row) => ({
          id: row.id,
          label: row.company ?? row.email ?? row.id,
        })),
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
        model: read.model,
        promptVersion: read.promptVersion,
        requestId: read.requestId,
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

    const { rows } = await buyers(envelope.buyerId);
    const buyer = envelope.buyerId
      ? (rows.find((row) => row.id === envelope.buyerId) ?? null)
      : null;

    // Re-matched and re-priced inside this request. The prices that go on the
    // order are this moment's, not the ones the page was showing — and the
    // merchant's answers to the ambiguous lines come with them.
    const matched = await matchPurchaseOrder(admin, envelope.lines, {
      buyer: {
        customerId: buyer?.customerId ?? null,
        tags: buyer?.tags ?? [],
        groupIds: buyer?.groupId ? [buyer.groupId] : [],
      },
      currencyCode,
      now,
      chosen: envelope.chosen,
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
      // Which model read the document, so the order can be joined to its run.
      ai: {
        model: envelope.model,
        promptVersion: envelope.promptVersion,
        requestId: envelope.requestId,
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

export default function PurchaseOrder() {
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <PurchaseOrderPage view={view as PurchaseOrderView} />;
}

import { runMutation, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";

/**
 * The Admin API calls the quote features make: finding something to quote, and
 * turning an accepted quote into a draft order.
 *
 * An accepted quote becomes a Shopify draft order, because that is the object a
 * merchant can invoice, edit and turn into an order — and it is where their
 * fulfilment and accounting apps are already looking.
 *
 * The prices go across as `originalUnitPriceWithCurrency`, which is Shopify's
 * way of saying "charge this, not the variant's price". Without it Shopify
 * would re-read each variant and the quote's whole promise would evaporate at
 * the last step.
 */

const DRAFT_ORDER_CREATE = `#graphql
  mutation MannonDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
      }
      userErrors {
        field
        message
      }
    }
  }`;

export interface DraftOrderLine {
  variantId: string;
  quantity: number;
  /** Minor units. Converted to the decimal string Shopify's MoneyInput takes. */
  unitPrice: number;
  currencyCode: string;
  /** The decimal form, produced by the engine's formatter. */
  unitPriceDecimal: string;
}

export interface DraftOrderResult {
  id: string;
  name: string;
  invoiceUrl: string | null;
}

export interface DraftOrderRequest {
  customerId: string | null;
  email: string | null;
  lines: DraftOrderLine[];
  note: string | null;
  tags: string[];
}

export async function createDraftOrder(
  admin: AdminGraphql,
  request: DraftOrderRequest,
): Promise<DraftOrderResult> {
  return runMutation<DraftOrderResult>(
    admin,
    "draftOrderCreate",
    DRAFT_ORDER_CREATE,
    {
      input: {
        ...(request.customerId
          ? { purchasingEntity: { customerId: request.customerId } }
          : {}),
        ...(request.email ? { email: request.email } : {}),
        ...(request.note ? { note: request.note } : {}),
        ...(request.tags.length ? { tags: request.tags } : {}),
        lineItems: request.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          // The locked price. This is the field that makes a quote a quote.
          originalUnitPriceWithCurrency: {
            amount: line.unitPriceDecimal,
            currencyCode: line.currencyCode,
          },
        })),
      },
    },
    (data) => {
      const payload = data.draftOrderCreate as {
        draftOrder: DraftOrderResult | null;
        userErrors: { message: string }[];
      };
      return {
        result: payload.draftOrder ?? { id: "", name: "", invoiceUrl: null },
        userErrors: payload.userErrors,
      };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Finding something to quote                                                  */
/* -------------------------------------------------------------------------- */

const VARIANT_SEARCH = `#graphql
  query MannonQuoteVariants($query: String!, $first: Int!) {
    productVariants(first: $first, query: $query) {
      nodes {
        id
        title
        sku
        price
        product {
          id
          title
        }
      }
    }
  }`;

export interface VariantMatch {
  id: string;
  /** "Blue Mug — Large", built from the product and variant titles. */
  title: string;
  sku: string | null;
  /** A decimal string in the shop's currency, as Shopify sends it. */
  price: string;
  productId: string;
}

interface VariantNode {
  id: string;
  title: string | null;
  sku: string | null;
  price: string | null;
  product: { id: string; title: string | null } | null;
}

/** How many matches a merchant is shown at once. */
export const VARIANT_SEARCH_LIMIT = 10;

/**
 * Search a merchant's catalogue for something to put on a quote.
 *
 * Returns an empty list rather than throwing: a quote half-built is worth more
 * than an error page, and the search box is the one part of this screen a
 * merchant can simply try again.
 */
/**
 * A search, and whether it actually ran.
 *
 * "No results" and "Shopify did not answer" are the same empty array and very
 * different sentences: one is a fact about the merchant's catalogue, the other
 * is a fact about us. PO-to-order prints one of them next to a line, so it
 * needs to know which.
 */
export interface VariantSearch {
  ok: boolean;
  matches: VariantMatch[];
}

/** Forgiving: an empty list on any failure. The quote builder's own behaviour. */
export async function searchVariants(
  admin: AdminGraphql,
  query: string,
  first: number = VARIANT_SEARCH_LIMIT,
): Promise<VariantMatch[]> {
  return (await searchVariantsResult(admin, query, first)).matches;
}

export async function searchVariantsResult(
  admin: AdminGraphql,
  query: string,
  first: number = VARIANT_SEARCH_LIMIT,
): Promise<VariantSearch> {
  const term = query.trim();
  if (!term) return { ok: true, matches: [] };

  try {
    const response = await admin.graphql(VARIANT_SEARCH, {
      // Quoted, so a term with a colon or a space cannot change the shape of
      // the search.
      variables: {
        query: `title:*${term.replace(/["\\]/g, "")}* OR sku:*${term.replace(/["\\]/g, "")}*`,
        first,
      },
    });

    const body = (await response.json()) as {
      data?: { productVariants?: { nodes: VariantNode[] } };
      errors?: { message: string }[];
    };

    if (body.errors?.length) {
      console.warn(
        `[mannon] variant search failed: ${body.errors.map((e) => e.message).join("; ")}`,
      );
      return { ok: false, matches: [] };
    }

    return {
      ok: true,
      matches: (body.data?.productVariants?.nodes ?? []).map((node) => ({
        id: node.id,
        title: [node.product?.title, node.title].filter(Boolean).join(" — ") || node.id,
        sku: node.sku?.trim() || null,
        price: node.price ?? "0",
        productId: node.product?.id ?? node.id,
      })),
    };
  } catch (error) {
    console.warn(
      `[mannon] variant search failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, matches: [] };
  }
}

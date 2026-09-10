import { runMutation, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";

/**
 * The Admin API calls the orders features make.
 *
 * Shopify owns the order; this app mirrors it so the wholesale list can sort,
 * filter and total without a round trip per row, and writes back exactly one
 * thing — a tag saying the order was wholesale, so a merchant can find the same
 * orders in Shopify's own admin.
 */

/**
 * Orders per page.
 *
 * Small, because of what hangs off each one. Shopify's calculated query cost
 * multiplies a connection by its `first`, so nesting `lineItems(first: M)`
 * inside `orders(first: N)` costs on the order of N × M object points against
 * a **1,000-point single-query maximum**. At the old 100 × 100 that was tens
 * of thousands: every page of the backfill would have been rejected outright,
 * every retry with it, and the merchant would have seen an empty Orders page
 * and empty charts with nothing to explain them.
 *
 * 10 × 50 keeps one page well inside the ceiling. The backfill re-queues
 * itself per page, so the only cost of a smaller page is more runs.
 */
export const ORDER_PAGE_SIZE = 10;

/**
 * Lines fetched per order.
 *
 * Not paginated per order: paging inside a page of orders turns one backfill
 * into thousands of round trips. A wholesale order with more lines than this
 * does exist, and `pageInfo.hasNextPage` says so — which is Shopify's own
 * answer to "is that all of them", rather than a quantity comparison this app
 * infers. See `linesTruncated` in `sync.server.ts`.
 */
export const LINE_PAGE_SIZE = 50;

const ORDER_FIELDS = `
    id
    name
    email
    createdAt
    processedAt
    cancelledAt
    updatedAt
    displayFinancialStatus
    displayFulfillmentStatus
    sourceName
    tags
    currentSubtotalLineItemsQuantity
    customer {
      id
      defaultAddress {
        company
      }
    }
    customAttributes {
      key
      value
    }
    currentTotalPriceSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    currentSubtotalPriceSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    totalRefundedSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    lineItems(first: ${LINE_PAGE_SIZE}) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        title
        variantTitle
        sku
        quantity
        currentQuantity
        product {
          id
        }
        variant {
          id
        }
        originalUnitPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        originalTotalSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        discountedTotalSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        discountAllocations {
          allocatedAmountSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          discountApplication {
            ... on AutomaticDiscountApplication {
              title
            }
            ... on DiscountCodeApplication {
              code
            }
            ... on ManualDiscountApplication {
              title
            }
            ... on ScriptDiscountApplication {
              title
            }
          }
        }
      }
    }`;

export const ORDERS_PAGE = `#graphql
  query MannonOrdersPage($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: PROCESSED_AT, reverse: true) {
      nodes {${ORDER_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

const ORDER_TAGS_ADD = `#graphql
  mutation MannonOrderTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }`;

export interface ShopMoney {
  shopMoney: { amount: string; currencyCode: string } | null;
}

/** What an order looks like coming back from the Admin API. */
export interface OrderNode {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: string | null;
  processedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  sourceName: string | null;
  tags: string[] | null;
  currentSubtotalLineItemsQuantity: number | null;
  customer: { id: string; defaultAddress: { company: string | null } | null } | null;
  customAttributes: { key: string; value: string | null }[] | null;
  currentTotalPriceSet: ShopMoney | null;
  currentSubtotalPriceSet: ShopMoney | null;
  totalRefundedSet: ShopMoney | null;
  lineItems: {
    /** Shopify's own answer to "is that all of them". */
    pageInfo?: { hasNextPage?: boolean | null } | null;
    nodes: OrderLineNode[];
  } | null;
}

/**
 * One line of an order, as the Admin API reports it.
 *
 * `discountApplication` is a union; only some members carry a `title`, so the
 * field is optional here and a missing one becomes an unnamed discount rather
 * than a crash.
 */
export interface OrderLineNode {
  id: string;
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  /** As ordered. */
  quantity: number | null;
  /** After returns and removals. Null on an API version that lacks it. */
  currentQuantity?: number | null;
  product: { id: string } | null;
  variant: { id: string } | null;
  originalUnitPriceSet: ShopMoney | null;
  originalTotalSet: ShopMoney | null;
  discountedTotalSet: ShopMoney | null;
  discountAllocations:
    | {
        allocatedAmountSet: ShopMoney | null;
        discountApplication: { title?: string | null; code?: string | null } | null;
      }[]
    | null;
}

export interface OrderPage {
  nodes: OrderNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export async function fetchOrderPage(
  admin: AdminGraphql,
  after: string | null,
  first: number = ORDER_PAGE_SIZE,
): Promise<OrderPage> {
  const response = await admin.graphql(ORDERS_PAGE, { variables: { first, after } });
  const body = (await response.json()) as {
    data?: {
      orders?: {
        nodes: OrderNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(
      `orders query failed: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const page = body.data?.orders;
  return {
    nodes: page?.nodes ?? [],
    hasNextPage: page?.pageInfo.hasNextPage ?? false,
    endCursor: page?.pageInfo.endCursor ?? null,
  };
}

/**
 * Tag an order as wholesale.
 *
 * Additive, like the customer tags: an order is very often already tagged by a
 * shipping or accounting app, and replacing the list would delete their work.
 */
export async function tagOrder(
  admin: AdminGraphql,
  orderId: string,
  tags: string[],
): Promise<void> {
  if (tags.length === 0) return;

  await runMutation<void>(
    admin,
    "tagsAdd(order)",
    ORDER_TAGS_ADD,
    { id: orderId, tags },
    (data) => ({
      result: undefined,
      userErrors: (data.tagsAdd as { userErrors: [] }).userErrors,
    }),
  );
}

import { runMutation, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";

/**
 * The Admin API calls the customer features make.
 *
 * Shopify owns the customer record; this app mirrors it and writes back two
 * things — tags and the tax-exempt flag. Tags are written with `tagsAdd` and
 * `tagsRemove` rather than by setting the whole list: other apps tag the same
 * customers, and a wholesale app that silently drops a loyalty app's tags is a
 * support ticket nobody can diagnose.
 */

/** Shopify's page cap for a customers query. */
export const CUSTOMER_PAGE_SIZE = 250;

const CUSTOMER_FIELDS = `
    id
    email
    firstName
    lastName
    phone
    state
    taxExempt
    tags
    numberOfOrders
    amountSpent {
      amount
      currencyCode
    }
    lastOrder {
      createdAt
    }
    defaultAddress {
      company
      countryCodeV2
      provinceCode
    }`;

export const CUSTOMERS_PAGE = `#graphql
  query MannonCustomersPage($first: Int!, $after: String) {
    customers(first: $first, after: $after, sortKey: ID) {
      nodes {${CUSTOMER_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

export const CUSTOMER_BY_ID = `#graphql
  query MannonCustomer($id: ID!) {
    customer(id: $id) {${CUSTOMER_FIELDS}
    }
  }`;

const TAGS_ADD = `#graphql
  mutation MannonCustomerTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }`;

const TAGS_REMOVE = `#graphql
  mutation MannonCustomerTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }`;

const SET_TAX_EXEMPT = `#graphql
  mutation MannonCustomerTaxExempt($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer {
        id
        taxExempt
      }
      userErrors {
        field
        message
      }
    }
  }`;

const CUSTOMER_BY_EMAIL = `#graphql
  query MannonCustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      nodes {${CUSTOMER_FIELDS}
      }
    }
  }`;

const CUSTOMER_CREATE = `#graphql
  mutation MannonCustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {${CUSTOMER_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }`;

/** What a customer looks like coming back from the Admin API. */
export interface CustomerNode {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  state: string | null;
  taxExempt: boolean | null;
  tags: string[] | null;
  /** An unsigned 64-bit count, which Shopify serialises as a string. */
  numberOfOrders: string | number | null;
  amountSpent: { amount: string; currencyCode: string } | null;
  lastOrder: { createdAt: string } | null;
  defaultAddress: {
    company: string | null;
    countryCodeV2: string | null;
    provinceCode: string | null;
  } | null;
}

export interface CustomerPage {
  nodes: CustomerNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export async function fetchCustomerPage(
  admin: AdminGraphql,
  after: string | null,
  first: number = CUSTOMER_PAGE_SIZE,
): Promise<CustomerPage> {
  const response = await admin.graphql(CUSTOMERS_PAGE, { variables: { first, after } });
  const body = (await response.json()) as {
    data?: {
      customers?: {
        nodes: CustomerNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(
      `customers query failed: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const page = body.data?.customers;
  return {
    nodes: page?.nodes ?? [],
    hasNextPage: page?.pageInfo.hasNextPage ?? false,
    endCursor: page?.pageInfo.endCursor ?? null,
  };
}

/** Read one customer. Returns null when Shopify no longer has them. */
export async function fetchCustomer(
  admin: AdminGraphql,
  customerId: string,
): Promise<CustomerNode | null> {
  const response = await admin.graphql(CUSTOMER_BY_ID, {
    variables: { id: customerId },
  });
  const body = (await response.json()) as {
    data?: { customer?: CustomerNode | null };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(
      `customer query failed: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  return body.data?.customer ?? null;
}

/**
 * Apply a tag change in Shopify.
 *
 * Additive and subtractive on purpose: two mutations rather than one write of
 * the whole list, so a tag another app added between our read and our write
 * survives.
 */
export async function applyTagChange(
  admin: AdminGraphql,
  customerId: string,
  change: { add: string[]; remove: string[] },
): Promise<void> {
  if (change.add.length > 0) {
    await runMutation<void>(
      admin,
      "tagsAdd(customer)",
      TAGS_ADD,
      { id: customerId, tags: change.add },
      (data) => ({
        result: undefined,
        userErrors: (data.tagsAdd as { userErrors: [] }).userErrors,
      }),
    );
  }

  if (change.remove.length > 0) {
    await runMutation<void>(
      admin,
      "tagsRemove(customer)",
      TAGS_REMOVE,
      { id: customerId, tags: change.remove },
      (data) => ({
        result: undefined,
        userErrors: (data.tagsRemove as { userErrors: [] }).userErrors,
      }),
    );
  }
}

export async function setTaxExempt(
  admin: AdminGraphql,
  customerId: string,
  taxExempt: boolean,
): Promise<void> {
  await runMutation<void>(
    admin,
    "customerUpdate(taxExempt)",
    SET_TAX_EXEMPT,
    { input: { id: customerId, taxExempt } },
    (data) => ({
      result: undefined,
      userErrors: (data.customerUpdate as { userErrors: [] }).userErrors,
    }),
  );
}

/**
 * Find a customer by email address.
 *
 * Used before creating one on approval: a wholesale applicant is very often
 * already a retail customer of the same store, and a second account would
 * split their order history in half.
 */
export async function findCustomerByEmail(
  admin: AdminGraphql,
  email: string,
): Promise<CustomerNode | null> {
  const response = await admin.graphql(CUSTOMER_BY_EMAIL, {
    // Quoted, so an address containing a space or a colon cannot change the
    // shape of the search.
    variables: { query: `email:"${email.replace(/"/g, "")}"` },
  });

  const body = (await response.json()) as {
    data?: { customers?: { nodes: CustomerNode[] } };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(
      `customer lookup failed: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  return body.data?.customers?.nodes?.[0] ?? null;
}

export interface NewCustomer {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  tags?: string[];
  note?: string | null;
}

export async function createCustomer(
  admin: AdminGraphql,
  customer: NewCustomer,
): Promise<CustomerNode> {
  return runMutation<CustomerNode>(
    admin,
    "customerCreate",
    CUSTOMER_CREATE,
    {
      input: {
        email: customer.email,
        ...(customer.firstName ? { firstName: customer.firstName } : {}),
        ...(customer.lastName ? { lastName: customer.lastName } : {}),
        // A phone Shopify rejects should not lose the whole approval, so it is
        // sent only when it looks like something Shopify will take.
        ...(customer.phone && /^\+/.test(customer.phone)
          ? { phone: customer.phone }
          : {}),
        ...(customer.tags?.length ? { tags: customer.tags } : {}),
        ...(customer.note ? { note: customer.note } : {}),
      },
    },
    (data) => {
      const payload = data.customerCreate as {
        customer: CustomerNode;
        userErrors: { message: string }[];
      };
      return { result: payload.customer, userErrors: payload.userErrors };
    },
  );
}

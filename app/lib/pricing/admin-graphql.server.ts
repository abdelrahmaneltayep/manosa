/**
 * The slice of the Admin API this app calls, behind one seam.
 *
 * Every mutation goes through `AdminGraphql` so tests can assert the exact
 * query and variables sent. That matters more than usual here: these calls
 * cannot be exercised without a real store, so the tests have to pin the
 * request rather than the response.
 */
export interface AdminGraphql {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export class AdminApiError extends Error {
  constructor(
    readonly operation: string,
    readonly userErrors: UserError[],
  ) {
    super(`${operation} failed: ${userErrors.map((error) => error.message).join("; ")}`);
    this.name = "AdminApiError";
  }
}

/** Run a mutation and turn Shopify's `userErrors` into a thrown error. */
export async function runMutation<T>(
  admin: AdminGraphql,
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  read: (data: Record<string, unknown>) => { result: T; userErrors: UserError[] },
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const body = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new AdminApiError(
      operation,
      body.errors.map((error) => ({ message: error.message })),
    );
  }
  if (!body.data) {
    throw new AdminApiError(operation, [{ message: "no data in response" }]);
  }

  const { result, userErrors } = read(body.data);
  if (userErrors?.length) throw new AdminApiError(operation, userErrors);

  return result;
}

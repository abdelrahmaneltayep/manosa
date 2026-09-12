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

/* -------------------------------------------------------------------------- */

/**
 * Being rate limited is not a failure, and this used to treat it as one.
 *
 * Shopify's GraphQL Admin API is cost-based: every request spends points from a
 * bucket that refills at a fixed rate, and a request that would overdraw it
 * comes back as a top-level error with `extensions.code === "THROTTLED"`. Both
 * readers below turned any top-level error into a thrown `AdminApiError`, so a
 * merchant on a big store pressing **Save** on a pricing rule could be told the
 * publish failed when the honest answer was "in a moment".
 *
 * **Retrying is safe here, and that is the whole reason this is allowed.** A
 * throttled request is rejected *before* it runs — Shopify never executed the
 * mutation — so re-sending it cannot double-charge, double-tag or double-write
 * anything. That is not true of a timeout or a 5xx, which is why neither of
 * those is retried here.
 *
 * The wait is computed from Shopify's own answer rather than guessed: the
 * response carries `extensions.cost.throttleStatus`, so the exact time until
 * enough points have restored is arithmetic. It is capped, because a person is
 * looking at a spinner — past the cap it gives up and says so, which is the
 * honest end of a wait nobody wants.
 */

/** How many extra attempts a throttled request gets. */
export const THROTTLE_RETRIES = 2;

/** Nobody watches a spinner longer than this for one save. */
export const MAX_THROTTLE_WAIT_MS = 5_000;

/** When Shopify does not say how long, wait this and try once more. */
const BLIND_WAIT_MS = 1_000;

interface ThrottleStatus {
  maximumAvailable?: number;
  currentlyAvailable?: number;
  restoreRate?: number;
}

interface AdminBody {
  data?: unknown;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: {
    cost?: { requestedQueryCost?: number; throttleStatus?: ThrottleStatus };
  };
}

const isThrottled = (body: AdminBody): boolean =>
  body.errors?.some(
    (error) =>
      error.extensions?.code === "THROTTLED" || /throttled/i.test(error.message ?? ""),
  ) ?? false;

/**
 * How long until this request could succeed, from Shopify's own figures.
 *
 * `null` when it cannot be worked out, which is a blind wait rather than a
 * guess dressed as arithmetic.
 */
export function throttleWaitMs(body: AdminBody): number | null {
  const cost = body.extensions?.cost;
  const status = cost?.throttleStatus;
  const needed = cost?.requestedQueryCost;

  if (
    typeof needed !== "number" ||
    typeof status?.currentlyAvailable !== "number" ||
    typeof status?.restoreRate !== "number" ||
    status.restoreRate <= 0
  ) {
    return null;
  }

  const short = needed - status.currentlyAvailable;
  if (short <= 0) return 0;

  // Points restore per second; round up so the retry is not a millisecond early
  // and thrown straight back.
  return Math.ceil((short / status.restoreRate) * 1000);
}

export interface AdminDeps {
  /** Injected so a test can prove the wait without taking it. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Send one request, waiting out a throttle rather than calling it a failure.
 *
 * Returns the parsed body. Top-level errors that are *not* a throttle are left
 * for the caller to raise, because a query and a mutation report them
 * differently.
 */
async function send(
  admin: AdminGraphql,
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  deps: AdminDeps,
): Promise<AdminBody> {
  const sleep = deps.sleep ?? realSleep;
  let body: AdminBody = {};

  for (let attempt = 0; attempt <= THROTTLE_RETRIES; attempt += 1) {
    const response = await admin.graphql(query, { variables });
    body = (await response.json()) as AdminBody;

    if (!isThrottled(body)) return body;
    if (attempt === THROTTLE_RETRIES) break;

    const wait = throttleWaitMs(body) ?? BLIND_WAIT_MS;
    if (wait > MAX_THROTTLE_WAIT_MS) {
      // Longer than anybody will wait on a save. Give up now rather than hold
      // the page and fail anyway.
      console.warn(
        `[mannon] ${operation} throttled; ${wait}ms to recover is past the ${MAX_THROTTLE_WAIT_MS}ms ceiling`,
      );
      break;
    }

    console.info(`[mannon] ${operation} throttled; retrying in ${wait}ms`);
    await sleep(wait);
  }

  return body;
}

/** The message a merchant gets when the wait ran out. */
const THROTTLE_MESSAGE =
  "Shopify is rate limiting this store right now. Nothing was changed — try again in a moment.";

function raiseIfThrottled(operation: string, body: AdminBody): void {
  if (!isThrottled(body)) return;
  throw new AdminApiError(operation, [{ message: THROTTLE_MESSAGE, code: "THROTTLED" }]);
}

/** Run a mutation and turn Shopify's `userErrors` into a thrown error. */
export async function runMutation<T>(
  admin: AdminGraphql,
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  read: (data: Record<string, unknown>) => { result: T; userErrors: UserError[] },
  deps: AdminDeps = {},
): Promise<T> {
  // Safe to retry: a throttled request is rejected before Shopify runs it, so
  // nothing was tagged, charged or published on the attempt that bounced.
  const body = (await send(admin, operation, query, variables, deps)) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };
  raiseIfThrottled(operation, body);

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

/**
 * Run a read and hand back its `data`.
 *
 * Queries have no `userErrors`, so the only failures are transport and
 * top-level GraphQL errors — both of which have to be loud. A margin guard
 * that silently reports "nothing below cost" because the read failed is worse
 * than no guard at all.
 */
export async function runQuery<T>(
  admin: AdminGraphql,
  operation: string,
  query: string,
  variables: Record<string, unknown> = {},
  deps: AdminDeps = {},
): Promise<T> {
  const body = (await send(admin, operation, query, variables, deps)) as {
    data?: T;
    errors?: { message: string }[];
  };
  raiseIfThrottled(operation, body);

  if (body.errors?.length) {
    throw new AdminApiError(
      operation,
      body.errors.map((error) => ({ message: error.message })),
    );
  }
  if (!body.data)
    throw new AdminApiError(operation, [{ message: "no data in response" }]);

  return body.data;
}

/**
 * What an order is worth, and what is still owed on it.
 *
 * One definition, because this app got it wrong in seven places at once.
 *
 * **`Order.totalPrice` is already net of refunds.** It is written from
 * Shopify's `current_total_price` / `currentTotalPriceSet`, which is the total
 * after edits *and* refunds — a $100 order with $40 refunded arrives as
 * `current_total_price: "60.00"` alongside `total_refunded: "40.00"`, and both
 * are stored as they came. Subtracting `refundedAmount` again removes the
 * refund a second time.
 *
 * That is what happened: the analytics revenue chart said $20.00 for that
 * order, the Home KPI card said $60.00, the Orders list said $60.00 and the
 * products chart said $65.00. Four numbers, one order, three of them on
 * screens a merchant can open side by side. `refundedAmount` is for *showing*
 * the refund, and for a gross figure if one is ever wanted — which is
 * `totalPrice + refundedAmount`, not the other way round.
 */

export interface OrderTotals {
  totalPrice: number;
  refundedAmount: number;
  amountPaid: number;
}

/** What the merchant kept. Never below zero. */
export const orderRevenue = (order: Pick<OrderTotals, "totalPrice">): number =>
  Math.max(0, order.totalPrice);

/** What is still to be collected on an invoice. */
export const amountOwed = (
  order: Pick<OrderTotals, "totalPrice" | "amountPaid">,
): number => Math.max(0, order.totalPrice - order.amountPaid);

/** Before any refund. The only figure `refundedAmount` belongs in. */
export const grossOrderValue = (
  order: Pick<OrderTotals, "totalPrice" | "refundedAmount">,
): number => order.totalPrice + order.refundedAmount;

/**
 * `orderRevenue` over a Prisma `_sum` aggregate.
 *
 * A month of retail orders is too many rows to pull just to add them up, so
 * the review aggregates in the database — but an aggregate cannot call
 * `orderRevenue` per row, and the last time this rule was restated by hand
 * rather than reused, the refund came off twice and a permanent review
 * disagreed with the charts one click away.
 *
 * It is the same rule: `totalPrice` is never negative (Shopify's
 * `current_total_price` cannot be), so the sum of the clamps equals the clamp
 * of the sum. `tests/unit/order-totals.test.ts` asserts the two agree over
 * arbitrary rows rather than leaving that as a comment.
 */
export const orderRevenueOfSum = (sum: { totalPrice: number | null }): number =>
  Math.max(0, sum.totalPrice ?? 0);

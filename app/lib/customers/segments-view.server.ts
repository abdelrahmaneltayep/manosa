import { formatCurrency } from "~/lib/money";
import type { Translate } from "~/i18n/translate";
import type { SegmentCondition } from "~/lib/customers/segments";

/**
 * A condition as a chip a merchant can read.
 *
 * Rendered on the server because the sentence needs a group's name and a
 * formatted amount — neither of which belongs in the client, and both of which
 * have to come out the same way in Arabic.
 */
export function describeCondition(
  condition: SegmentCondition,
  t: Translate,
  groups: ReadonlyMap<string, string>,
  locale = "en",
): string {
  switch (condition.field) {
    case "lifetime_spend":
      return t(`segments.chip.lifetime_spend.${condition.op}`, {
        amount: formatCurrency(condition.amount, locale),
      });

    case "order_count":
      return t(`segments.chip.order_count.${condition.op}`, {
        count: condition.value,
      });

    case "last_order_days":
      return t(`segments.chip.last_order_days.${condition.op}`, {
        count: condition.value,
      });

    case "never_ordered":
      return t("segments.chip.never_ordered");

    case "tag":
      return t(`segments.chip.tag.${condition.op}`, { tag: condition.value });

    case "group":
      return t(`segments.chip.group.${condition.op}`, {
        // A group deleted since the segment was saved reads as its id, which is
        // ugly and honest — better than a chip that quietly names nothing.
        group: groups.get(condition.groupId) ?? condition.groupId,
      });

    case "country":
      return t(`segments.chip.country.${condition.op}`, { country: condition.value });

    case "tax_exempt":
      return t(condition.value ? "segments.chip.tax_exempt" : "segments.chip.tax_liable");

    case "status":
      return t("segments.chip.status", {
        status: t(`customers.status.${condition.value}`),
      });
  }
}

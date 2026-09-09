/**
 * Boolean attributes on Polaris web components.
 *
 * React stringifies props on a custom element, so `disabled={false}` renders
 * `disabled="false"` — and a browser reads any value at all, including the
 * string "false", as the attribute being set. The attribute has to be omitted,
 * not set to false.
 *
 * This has bitten this codebase twice: a "create rule" button that would have
 * been permanently dead, and a combinations checkbox that showed ticked when
 * the rule did not combine. Passing a boolean straight through is never right.
 */
export const whenDisabled = (value: boolean) => (value ? { disabled: true } : {});
export const whenChecked = (value: boolean) => (value ? { checked: true } : {});
export const whenLoading = (value: boolean) => (value ? { loading: true } : {});

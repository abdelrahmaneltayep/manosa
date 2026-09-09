/**
 * The CSV templates a merchant can download and fill in.
 *
 * Two, not one: a single sheet flexible enough for every rule type would have
 * twenty columns and be worse than either. Each template does one job, and the
 * download includes an example row so the shape is obvious without reading
 * documentation.
 */

export const TEMPLATE_KEYS = ["rules", "quantity_breaks"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface TemplateColumn {
  key: string;
  required: boolean;
  /** Shown in the mapping screen and in the downloaded template's help row. */
  i18nKey: string;
  example: string;
}

export interface TemplateDefinition {
  key: TemplateKey;
  i18nKey: string;
  columns: TemplateColumn[];
  /** Rows sharing this column merge into one rule. */
  groupBy?: string;
  exampleRows: string[][];
}

const AUDIENCE_COLUMNS: TemplateColumn[] = [
  {
    key: "customer_tags",
    required: false,
    i18nKey: "csv.column.customerTags",
    example: "wholesale",
  },
];

const TARGET_COLUMNS: TemplateColumn[] = [
  {
    key: "applies_to",
    required: false,
    i18nKey: "csv.column.appliesTo",
    example: "all",
  },
  {
    key: "skus",
    required: false,
    i18nKey: "csv.column.skus",
    example: "",
  },
];

export const TEMPLATES: Record<TemplateKey, TemplateDefinition> = {
  rules: {
    key: "rules",
    i18nKey: "csv.template.rules",
    columns: [
      {
        key: "rule_name",
        required: true,
        i18nKey: "csv.column.ruleName",
        example: "Wholesale 35%",
      },
      { key: "type", required: true, i18nKey: "csv.column.type", example: "percentage" },
      { key: "value", required: true, i18nKey: "csv.column.value", example: "35" },
      ...TARGET_COLUMNS,
      ...AUDIENCE_COLUMNS,
      { key: "status", required: false, i18nKey: "csv.column.status", example: "draft" },
      {
        key: "priority",
        required: false,
        i18nKey: "csv.column.priority",
        example: "100",
      },
      {
        key: "combinable",
        required: false,
        i18nKey: "csv.column.combinable",
        example: "no",
      },
      { key: "starts_at", required: false, i18nKey: "csv.column.startsAt", example: "" },
      { key: "ends_at", required: false, i18nKey: "csv.column.endsAt", example: "" },
    ],
    exampleRows: [
      [
        "Wholesale 35%",
        "percentage",
        "35",
        "all",
        "",
        "wholesale",
        "draft",
        "100",
        "no",
        "",
        "",
      ],
      // Targets everything rather than an example SKU: a merchant who
      // downloads this and imports it unchanged should get two draft rules,
      // not an error about a SKU that only exists in our example. How to
      // target SKUs is explained by the column's help text instead.
      [
        "Contract price",
        "fixed_price",
        "8.00",
        "all",
        "",
        "wholesale",
        "draft",
        "50",
        "no",
        "",
        "",
      ],
    ],
  },

  quantity_breaks: {
    key: "quantity_breaks",
    i18nKey: "csv.template.quantityBreaks",
    // Rows with the same name become one rule with several breaks, which is how
    // a merchant thinks about "buy 5 get 5%, buy 20 get 12%".
    groupBy: "rule_name",
    columns: [
      {
        key: "rule_name",
        required: true,
        i18nKey: "csv.column.ruleName",
        example: "Gold tiers",
      },
      ...TARGET_COLUMNS,
      ...AUDIENCE_COLUMNS,
      {
        key: "min_quantity",
        required: true,
        i18nKey: "csv.column.minQuantity",
        example: "5",
      },
      {
        key: "max_quantity",
        required: false,
        i18nKey: "csv.column.maxQuantity",
        example: "19",
      },
      {
        key: "discount_type",
        required: true,
        i18nKey: "csv.column.discountType",
        example: "percentage",
      },
      {
        key: "discount_value",
        required: true,
        i18nKey: "csv.column.discountValue",
        example: "5",
      },
      { key: "status", required: false, i18nKey: "csv.column.status", example: "draft" },
      {
        key: "priority",
        required: false,
        i18nKey: "csv.column.priority",
        example: "100",
      },
    ],
    exampleRows: [
      [
        "Gold tiers",
        "all",
        "",
        "wholesale",
        "5",
        "19",
        "percentage",
        "5",
        "draft",
        "100",
      ],
      [
        "Gold tiers",
        "all",
        "",
        "wholesale",
        "20",
        "",
        "percentage",
        "12",
        "draft",
        "100",
      ],
    ],
  },
};

export function isTemplateKey(value: unknown): value is TemplateKey {
  return (
    typeof value === "string" && (TEMPLATE_KEYS as readonly string[]).includes(value)
  );
}

/** Which template a file looks like, from its headers. */
export function detectTemplate(headers: string[]): TemplateKey | null {
  const present = new Set(headers);
  if (present.has("min_quantity") || present.has("discount_value"))
    return "quantity_breaks";
  if (present.has("type") && present.has("value")) return "rules";
  return null;
}

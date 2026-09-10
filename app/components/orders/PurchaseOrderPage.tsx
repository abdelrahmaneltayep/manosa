import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type { PoLineView, PurchaseOrderView } from "~/components/orders/types";

/**
 * ✦ PO-to-order — checklist §5.
 *
 * "Totals always recomputed from Mannon rules — never trust the PO's own
 * prices", and "unmatched lines listed, never dropped silently". Both are
 * visible on this screen: every line shows what it matched and how sure that
 * is, the price beside it came from the engine, and where the document
 * disagrees the difference is printed rather than reconciled.
 */
export function PurchaseOrderPage({ view }: { view: PurchaseOrderView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("po.heading")}>
      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href="/app/orders">{t("orders.list.tabOrders")}</s-link>
          <s-link href="/app/orders/limits">{t("orders.list.tabLimits")}</s-link>
          <s-link href="/app/orders/terms">{t("orders.list.tabTerms")}</s-link>
          <s-link href="/app/orders/quotes">{t("orders.list.tabQuotes")}</s-link>
          <s-link href="/app/orders/po" aria-current="page">
            {t("orders.list.tabPo")}
          </s-link>
        </s-stack>
      </s-section>

      {view.created ? <Created view={view} /> : null}
      <Composer view={view} />
      {view.lines.length > 0 ? <Review view={view} /> : null}
    </s-page>
  );
}

function Created({ view }: { view: PurchaseOrderView }) {
  const { t } = useTranslation();
  const created = view.created!;

  return (
    <s-section>
      <s-banner tone="success">
        <s-heading>{t("po.createdHeading", { name: created.name })}</s-heading>
        <s-paragraph>{t("po.createdBody")}</s-paragraph>
        {created.invoiceUrl ? (
          <s-button href={created.invoiceUrl} target="_blank">
            {t("po.openInvoice")}
          </s-button>
        ) : null}
      </s-banner>
    </s-section>
  );
}

function Composer({ view }: { view: PurchaseOrderView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("po.composerHeading")}>
      <s-stack direction="block" gap="base">
        {view.locked ? (
          <s-banner tone="info">
            <s-heading>{t(`po.locked.${view.locked}Heading`)}</s-heading>
            <s-paragraph>{t(`po.locked.${view.locked}Body`)}</s-paragraph>
            {view.locked === "plan" ? (
              <s-button href="/app/plans?from=po">{t("po.seePlans")}</s-button>
            ) : null}
          </s-banner>
        ) : null}

        {view.fileError ? (
          <s-banner tone="warning">
            <s-heading>{t(`po.fileError.${view.fileError}Heading`)}</s-heading>
            {/* The checklist's exact fallback: paste the lines as text. */}
            <s-paragraph>{t("po.fileError.paste")}</s-paragraph>
          </s-banner>
        ) : null}

        {view.failure ? (
          <s-banner tone="warning">
            <s-heading>{t(`po.failure.${view.failure}.heading`)}</s-heading>
            <s-paragraph>{t(`po.failure.${view.failure}.body`)}</s-paragraph>
          </s-banner>
        ) : null}

        <form method="post" encType="multipart/form-data">
          <input type="hidden" name="intent" value="read" />
          <s-stack direction="block" gap="small">
            <s-select
              name="buyerId"
              label={t("po.buyerLabel")}
              details={t("po.buyerHelp")}
              value={view.buyer?.id ?? ""}
              {...whenDisabled(!view.available)}
            >
              <s-option value="">{t("po.noBuyer")}</s-option>
              {view.buyers.map((buyer) => (
                <s-option key={buyer.id} value={buyer.id}>
                  {buyer.label}
                </s-option>
              ))}
            </s-select>
            <s-text-area
              name="text"
              rows={8}
              label={t("po.textLabel")}
              details={t("po.textHelp")}
              value={view.text}
              {...whenDisabled(!view.available)}
            />
            {/* A plain input, as on the CSV page: Polaris has no file control
                that posts in a normal multipart form without JavaScript. */}
            <s-stack direction="block" gap="small-500">
              <s-text>{t("po.fileLabel")}</s-text>
              <input
                type="file"
                name="file"
                accept=".csv,.txt,.eml,.tsv,text/plain"
                aria-label={t("po.fileLabel")}
                {...(view.available ? {} : { disabled: true })}
              />
            </s-stack>
            <s-button type="submit" variant="primary" {...whenDisabled(!view.available)}>
              {t("po.readAction")}
            </s-button>
          </s-stack>
        </form>
      </s-stack>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */

const TONE = {
  exact: "success",
  likely: "warning",
  ambiguous: "warning",
  none: "critical",
} as const;

function Review({ view }: { view: PurchaseOrderView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("po.reviewHeading")}>
      <s-stack direction="block" gap="base">
        <s-banner tone="info">
          <s-paragraph>{t("po.pricesAreOurs")}</s-paragraph>
        </s-banner>

        {view.notes ? (
          <s-stack direction="block" gap="small-100">
            <s-text color="subdued">{t("po.notesHeading")}</s-text>
            <s-paragraph color="subdued">{view.notes}</s-paragraph>
          </s-stack>
        ) : null}

        {view.needsAttention > 0 ? (
          <s-banner tone="warning">
            <s-heading>
              {t("po.needsAttention", { count: view.needsAttention })}
            </s-heading>
            <s-paragraph>{t("po.needsAttentionBody")}</s-paragraph>
          </s-banner>
        ) : null}

        <s-stack direction="block" gap="small">
          {view.lines.map((line) => (
            <Line key={line.index} line={line} view={view} />
          ))}
        </s-stack>

        {view.subtotal ? (
          <s-heading>{t("po.subtotal", { amount: view.subtotal })}</s-heading>
        ) : null}

        <form method="post">
          <input type="hidden" name="intent" value="create" />
          <input type="hidden" name="payload" value={view.payload} />
          <s-button
            type="submit"
            variant="primary"
            {...whenDisabled(!view.available || view.subtotal === null)}
          >
            {t("po.createAction")}
          </s-button>
        </form>
      </s-stack>
    </s-section>
  );
}

function Line({ line, view }: { line: PoLineView; view: PurchaseOrderView }) {
  const { t } = useTranslation();

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderStyle="solid"
      borderColor="base"
      borderRadius="base"
    >
      <s-stack direction="block" gap="small-100">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge tone={TONE[line.confidence]}>
            {t(`po.confidence.${line.confidence}`)}
          </s-badge>
          <s-text type="strong">
            {t("po.requested", { quantity: line.quantity, what: line.requested })}
          </s-text>
        </s-stack>

        {line.matched ? (
          <s-text>
            {t("po.matched", { title: line.matched, sku: line.sku ?? "—" })}
          </s-text>
        ) : (
          // Listed, never dropped. The merchant decides what this line was.
          <s-text>{t("po.unmatched")}</s-text>
        )}

        {line.unitPrice ? (
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text>
              {t("po.contractPrice", {
                unit: line.unitPrice,
                total: line.lineTotal ?? "",
              })}
            </s-text>
            {line.ruleSummary ? <s-badge tone="info">{line.ruleSummary}</s-badge> : null}
          </s-stack>
        ) : null}

        {line.statedPrice && line.priceDelta ? (
          // "PO says $4.00, contract price is $4.10" — printed, not reconciled.
          <s-text color="subdued">
            {t("po.priceDelta", {
              stated: line.statedPrice,
              contract: line.unitPrice ?? "",
              delta: line.priceDelta,
            })}
          </s-text>
        ) : null}

        {line.candidates.length > 0 ? (
          <form method="post">
            <input type="hidden" name="intent" value="choose" />
            <input type="hidden" name="payload" value={view.payload} />
            <input type="hidden" name="index" value={String(line.index)} />
            <s-stack direction="inline" gap="small" alignItems="end">
              <s-select name="variantId" label={t("po.whichOne")} value="">
                {line.candidates.map((candidate) => (
                  <s-option key={candidate.id} value={candidate.id}>
                    {candidate.sku
                      ? `${candidate.label} · ${candidate.sku}`
                      : candidate.label}
                  </s-option>
                ))}
              </s-select>
              <s-button type="submit">{t("po.useThis")}</s-button>
            </s-stack>
          </form>
        ) : null}
      </s-stack>
    </s-box>
  );
}

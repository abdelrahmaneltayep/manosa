import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type { QuoteDetailView, QuoteLineView } from "~/components/orders/types";

/**
 * One quote: what was asked for, what it costs, and what happens next.
 *
 * The prices on this page came from the pricing engine once, when the quote was
 * drafted, and they do not move. Where the store would now charge something
 * different the row says so — not to change it, but because a merchant about to
 * honour a fortnight-old quote wants to know.
 */
export function QuoteDetailPage({ view }: { view: QuoteDetailView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={view.number}>
      <s-section>
        <s-link href="/app/orders/quotes">{t("quotes.detail.back")}</s-link>
      </s-section>

      {view.error ? (
        <s-section>
          <s-banner tone="critical">
            <s-paragraph>{view.error}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {view.entitled ? null : (
        <s-section>
          <s-banner tone="info">
            <s-heading>{t("quotes.lockedHeading")}</s-heading>
            <s-paragraph>
              {t("quotes.lockedBody", { plan: view.requiredPlan })}
            </s-paragraph>
            <s-button href="/app/plans">{t("quotes.lockedAction")}</s-button>
          </s-banner>
        </s-section>
      )}

      <Header view={view} />
      {view.requestNote ? <Request view={view} /> : null}
      {view.hasDrift ? <Drift /> : null}

      <Catalogue view={view} />

      <s-section heading={t("quotes.detail.linesHeading")}>
        {view.lines.length === 0 ? (
          <s-stack direction="block" gap="small">
            <s-heading>{t("quotes.detail.noLinesHeading")}</s-heading>
            <s-paragraph color="subdued">{t("quotes.detail.noLinesBody")}</s-paragraph>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            <LineTable view={view} />
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">{t("quotes.detail.subtotal")}</s-text>
              <s-text fontVariantNumeric="tabular-nums">{view.subtotal}</s-text>
            </s-stack>
            {view.lockedLabel ? (
              <s-text color="subdued">{view.lockedLabel}</s-text>
            ) : null}
          </s-stack>
        )}
      </s-section>

      <Suggestion view={view} />
      <Actions view={view} />
      {view.publicUrl ? <BuyerLink view={view} /> : null}
      {view.draftOrder ? <Accepted view={view} /> : null}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Header({ view }: { view: QuoteDetailView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("quotes.detail.buyerHeading")}>
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small-500" alignItems="center">
          <s-badge tone={view.statusTone}>{view.statusLabel}</s-badge>
          {view.source === "BUYER_AGENT" ? (
            <s-badge tone="info">✦ {t("quotes.source.BUYER_AGENT")}</s-badge>
          ) : null}
          {view.expiryLabel ? <s-text color="subdued">{view.expiryLabel}</s-text> : null}
        </s-stack>

        {view.buyer.href ? (
          <s-link href={view.buyer.href}>{view.buyer.name}</s-link>
        ) : (
          <s-text>{view.buyer.name}</s-text>
        )}
        {view.buyer.email ? <s-text color="subdued">{view.buyer.email}</s-text> : null}
        {/* Buyer context: tier and history, so a merchant pricing a quote is
            not guessing at who they are talking to. */}
        {view.buyer.context ? (
          <s-text color="subdued">{view.buyer.context}</s-text>
        ) : null}
      </s-stack>
    </s-section>
  );
}

function Request({ view }: { view: QuoteDetailView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("quotes.detail.requestHeading")}>
      <s-box background="subdued" padding="base" borderRadius="base">
        <s-paragraph>{view.requestNote}</s-paragraph>
      </s-box>
    </s-section>
  );
}

/** The locked-price explanation, once and at the top. */
function Drift() {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="info">
        <s-heading>{t("quotes.detail.driftHeading")}</s-heading>
        <s-paragraph>{t("quotes.detail.driftBody")}</s-paragraph>
      </s-banner>
    </s-section>
  );
}

function LineTable({ view }: { view: QuoteDetailView }) {
  const { t } = useTranslation();

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{t("quotes.detail.colItem")}</s-table-header>
        <s-table-header>{t("quotes.detail.colQuantity")}</s-table-header>
        <s-table-header>{t("quotes.detail.colUnitPrice")}</s-table-header>
        <s-table-header>{t("quotes.detail.colTotal")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.lines.map((line) => (
          <LineRow
            key={line.id}
            line={line}
            editable={view.actions.draft && view.entitled}
          />
        ))}
      </s-table-body>
    </s-table>
  );
}

function LineRow({ line, editable }: { line: QuoteLineView; editable: boolean }) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-text>{line.title}</s-text>
          {line.sku ? <s-text color="subdued">{line.sku}</s-text> : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-text fontVariantNumeric="tabular-nums">{line.quantity}</s-text>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-text fontVariantNumeric="tabular-nums">{line.unitPrice}</s-text>
          {/* Which rule produced this price — deciding shows its working. */}
          {line.ruleSummary ? (
            <s-text color="subdued">{line.ruleSummary}</s-text>
          ) : (
            <s-text color="subdued">{t("quotes.detail.manualPrice")}</s-text>
          )}
          {line.currentPrice ? (
            <s-badge tone="info">
              {t("quotes.detail.lockedChip", { current: line.currentPrice })}
            </s-badge>
          ) : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-text fontVariantNumeric="tabular-nums">{line.lineTotal}</s-text>
          {editable ? (
            <form method="post">
              <input type="hidden" name="intent" value="removeLine" />
              <input type="hidden" name="lineId" value={line.id} />
              <s-button variant="tertiary" tone="critical" type="submit">
                {t("quotes.detail.removeLine")}
              </s-button>
            </form>
          ) : null}
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

/**
 * Finding something to quote.
 *
 * A GET form and a POST per result: no picker, no JavaScript, and it works the
 * same whether or not App Bridge has loaded.
 */
function Catalogue({ view }: { view: QuoteDetailView }) {
  const { t } = useTranslation();
  if (!view.actions.draft) return null;

  return (
    <s-section heading={t("quotes.detail.addHeading")}>
      <s-stack direction="block" gap="base">
        <form method="get">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-search-field
              name="q"
              label={t("quotes.detail.searchLabel")}
              details={t("quotes.detail.searchHelp")}
              value={view.search.query}
            />
            <s-button type="submit" {...whenDisabled(!view.entitled)}>
              {t("quotes.detail.searchAction")}
            </s-button>
          </s-stack>
        </form>

        {view.search.results.length > 0 ? (
          <s-table>
            <s-table-header-row>
              <s-table-header>{t("quotes.detail.colItem")}</s-table-header>
              <s-table-header>{t("quotes.detail.colListPrice")}</s-table-header>
              <s-table-header>{t("quotes.detail.colAdd")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {view.search.results.map((result) => (
                <s-table-row key={result.variantId}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-500">
                      <s-text>{result.title}</s-text>
                      {result.sku ? <s-text color="subdued">{result.sku}</s-text> : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text fontVariantNumeric="tabular-nums">{result.price}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <form method="post">
                      <input type="hidden" name="intent" value="addLine" />
                      <input type="hidden" name="variantId" value={result.variantId} />
                      <input type="hidden" name="productId" value={result.productId} />
                      {/* Newline-separated: a form field is a string, and the
                          action splits it rather than parsing JSON posted from
                          a page. Without these two the added line is priced
                          with no product and no collections. */}
                      <input
                        type="hidden"
                        name="collectionIds"
                        value={result.collectionIds.join("\n")}
                      />
                      <input type="hidden" name="title" value={result.title} />
                      <input type="hidden" name="sku" value={result.sku ?? ""} />
                      <input type="hidden" name="listPrice" value={result.price} />
                      <s-stack direction="inline" gap="small-500" alignItems="end">
                        <s-number-field
                          name="quantity"
                          label={t("quotes.detail.colQuantity")}
                          labelAccessibilityVisibility="exclusive"
                          value="1"
                        />
                        <s-button type="submit" {...whenDisabled(!view.entitled)}>
                          {t("quotes.detail.add")}
                        </s-button>
                      </s-stack>
                    </form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : view.search.searched ? (
          <s-paragraph color="subdued">
            {t("quotes.detail.searchNoResults", { query: view.search.query })}
          </s-paragraph>
        ) : null}
      </s-stack>
    </s-section>
  );
}

/** ✦ The margin-floor check. Present but honest about not being ready. */
function Suggestion({ view }: { view: QuoteDetailView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("quotes.detail.suggestionHeading")}>
      <s-stack direction="block" gap="small">
        <s-paragraph color="subdued">
          {t(
            view.aiAvailable
              ? "quotes.detail.suggestionBody"
              : "quotes.detail.suggestionUnavailable",
          )}
        </s-paragraph>
        <s-button {...whenDisabled(!view.aiAvailable)}>
          {t("quotes.detail.suggestAction")}
        </s-button>
      </s-stack>
    </s-section>
  );
}

function Actions({ view }: { view: QuoteDetailView }) {
  const { t } = useTranslation();
  const { actions } = view;

  return (
    <s-section heading={t("quotes.detail.actionsHeading")}>
      <s-stack direction="block" gap="base">
        <form method="post">
          <input type="hidden" name="intent" value="draft" />
          <s-stack direction="block" gap="small">
            <s-text-area
              name="message"
              label={t("quotes.detail.messageLabel")}
              details={t("quotes.detail.messageHelp")}
              value={view.message}
            />
            <s-text-area
              name="internalNote"
              label={t("quotes.detail.internalNoteLabel")}
              details={t("quotes.detail.internalNoteHelp")}
              value={view.internalNote}
            />
            <s-button
              variant="primary"
              type="submit"
              {...whenDisabled(!actions.draft || !view.entitled)}
            >
              {t(
                view.lines.length === 0 ? "quotes.detail.price" : "quotes.detail.reprice",
              )}
            </s-button>
          </s-stack>
        </form>

        <s-stack direction="inline" gap="small">
          <form method="post">
            <input type="hidden" name="intent" value="send" />
            <s-button type="submit" {...whenDisabled(!actions.send || !view.entitled)}>
              {t("quotes.detail.send")}
            </s-button>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="withdraw" />
            <s-button
              variant="tertiary"
              tone="critical"
              type="submit"
              {...whenDisabled(!actions.withdraw || !view.entitled)}
            >
              {t("quotes.detail.withdraw")}
            </s-button>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="reopen" />
            <s-button
              variant="tertiary"
              type="submit"
              {...whenDisabled(!actions.reopen || !view.entitled)}
            >
              {t("quotes.detail.reopen")}
            </s-button>
          </form>
        </s-stack>

        {/* Says why a sent quote cannot be edited, rather than leaving a
            merchant looking at greyed-out buttons. */}
        {view.status === "SENT" ? (
          <s-paragraph color="subdued">{t("quotes.detail.sentLocked")}</s-paragraph>
        ) : null}
      </s-stack>
    </s-section>
  );
}

function BuyerLink({ view }: { view: QuoteDetailView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("quotes.detail.linkHeading")}>
      <s-stack direction="block" gap="small">
        <s-paragraph color="subdued">{t("quotes.detail.linkBody")}</s-paragraph>
        <s-text-field
          name="publicUrl"
          label={t("quotes.detail.linkLabel")}
          value={view.publicUrl ?? ""}
          readOnly
        />
      </s-stack>
    </s-section>
  );
}

function Accepted({ view }: { view: QuoteDetailView }) {
  const { t } = useTranslation();
  if (!view.draftOrder) return null;

  return (
    <s-section heading={t("quotes.detail.acceptedHeading")}>
      <s-stack direction="block" gap="small">
        <s-paragraph>{t("quotes.detail.acceptedBody")}</s-paragraph>
        <s-link href={view.draftOrder.href} target="_blank">
          {view.draftOrder.name}
        </s-link>
      </s-stack>
    </s-section>
  );
}

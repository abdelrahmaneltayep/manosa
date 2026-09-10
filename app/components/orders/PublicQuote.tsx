import { useTranslation } from "react-i18next";

/**
 * The quote a buyer opens from their email.
 *
 * Plain HTML on the app's own domain, like the registration form, and for the
 * same reason: no App Bridge, no Polaris, and it works with JavaScript off.
 * A buyer accepting a quote is committing to a price — that must not depend on
 * a script loading.
 */

export interface PublicQuoteLineView {
  title: string;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

export interface PublicQuoteView {
  action: string;
  shopName: string;
  number: string;
  company: string | null;
  message: string | null;
  lines: PublicQuoteLineView[];
  subtotal: string;
  /** Already-translated. Null when it never expires. */
  expiryLabel: string | null;
  /** Only a sent quote inside its date can be acted on. */
  canRespond: boolean;
  /** Why not, when it cannot — already translated. */
  closedReason: string | null;
  dir: "ltr" | "rtl";
}

const page: React.CSSProperties = {
  maxWidth: "42rem",
  margin: "0 auto",
  padding: "2rem 1.25rem",
  font: "16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#1c1d2b",
};

const cell: React.CSSProperties = {
  padding: "0.55rem 0.4rem",
  borderBottom: "1px solid #e6e6e6",
  textAlign: "start",
};

export function PublicQuote({ view }: { view: PublicQuoteView }) {
  const { t } = useTranslation();

  return (
    <div style={page} dir={view.dir}>
      <p style={{ color: "#5c5f77", margin: 0 }}>{view.shopName}</p>
      <h1 style={{ fontSize: "1.6rem", margin: "0.25rem 0 1rem" }}>
        {t("quotes.public.heading", { number: view.number })}
      </h1>

      {view.company ? (
        <p style={{ margin: "0 0 1rem", color: "#5c5f77" }}>
          {t("quotes.public.for", { company: view.company })}
        </p>
      ) : null}

      {view.message ? (
        <div
          style={{
            background: "#f6f6f8",
            border: "1px solid #e6e6e6",
            borderRadius: "8px",
            padding: "0.9rem 1rem",
            margin: "0 0 1.25rem",
          }}
        >
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{view.message}</p>
        </div>
      ) : null}

      <table style={{ width: "100%", borderCollapse: "collapse", margin: "0 0 1rem" }}>
        <thead>
          <tr>
            <th style={{ ...cell, fontWeight: 700 }}>{t("quotes.public.colItem")}</th>
            <th style={{ ...cell, fontWeight: 700 }}>{t("quotes.public.colQuantity")}</th>
            <th style={{ ...cell, fontWeight: 700 }}>
              {t("quotes.public.colUnitPrice")}
            </th>
            <th style={{ ...cell, fontWeight: 700 }}>{t("quotes.public.colTotal")}</th>
          </tr>
        </thead>
        <tbody>
          {view.lines.map((line, index) => (
            <tr key={`${line.sku ?? line.title}-${index}`}>
              <td style={cell}>
                {line.title}
                {line.sku ? (
                  <span
                    style={{ display: "block", color: "#5c5f77", fontSize: "0.85em" }}
                  >
                    {line.sku}
                  </span>
                ) : null}
              </td>
              <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>
                {line.quantity}
              </td>
              <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>
                {line.unitPrice}
              </td>
              <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>
                {line.lineTotal}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ fontWeight: 700, fontSize: "1.15rem", margin: "0 0 0.5rem" }}>
        {t("quotes.public.total", { amount: view.subtotal })}
      </p>

      {view.expiryLabel ? (
        <p style={{ color: "#5c5f77", margin: "0 0 1.5rem" }}>{view.expiryLabel}</p>
      ) : null}

      {view.canRespond ? (
        <form method="post" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            type="submit"
            name="intent"
            value="accept"
            style={{
              background: "#1f6f4a",
              color: "#fff",
              border: 0,
              borderRadius: "8px",
              padding: "0.7rem 1.4rem",
              font: "inherit",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {t("quotes.public.accept")}
          </button>
          <button
            type="submit"
            name="intent"
            value="decline"
            style={{
              background: "transparent",
              color: "#5c5f77",
              border: "1px solid #c9c9c9",
              borderRadius: "8px",
              padding: "0.7rem 1.4rem",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            {t("quotes.public.decline")}
          </button>
        </form>
      ) : (
        <div
          style={{
            background: "#fff4e4",
            border: "1px solid #e0b252",
            borderRadius: "8px",
            padding: "0.9rem 1rem",
          }}
        >
          <p style={{ margin: 0 }}>{view.closedReason}</p>
        </div>
      )}

      <p style={{ color: "#8a8ca0", fontSize: "0.85em", marginTop: "2rem" }}>
        {t("quotes.public.footer", { shopName: view.shopName })}
      </p>
    </div>
  );
}

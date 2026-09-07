import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { useTranslation } from "react-i18next";

import { login } from "~/shopify.server";

/**
 * The unembedded entry point: someone opened the app URL directly instead of
 * through the Shopify admin. If a shop is already in the query string Shopify
 * takes over; otherwise we ask which store to install on.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/auth/login?${url.searchParams.toString()}`);
  }

  return json({ showForm: Boolean(login) });
};

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();
  const { t } = useTranslation();

  return (
    <main style={styles.main}>
      <section style={styles.card}>
        <p style={styles.eyebrow}>{t("app.name")}</p>
        <h1 style={styles.heading}>
          {t("install.headingLead")}{" "}
          <span style={styles.accent}>{t("install.headingAccent")}</span>
        </h1>
        <p style={styles.body}>{t("install.body")}</p>

        {showForm ? (
          <Form method="post" action="/auth/login" style={styles.form}>
            <label style={styles.label} htmlFor="shop">
              {t("install.shopLabel")}
            </label>
            <input
              id="shop"
              type="text"
              name="shop"
              required
              autoComplete="off"
              placeholder={t("install.shopPlaceholder")}
              style={styles.input}
            />
            <button type="submit" style={styles.button}>
              {t("install.submit")}
            </button>
            <p style={styles.hint}>{t("install.hint")}</p>
          </Form>
        ) : null}
      </section>
    </main>
  );
}

// This page renders outside the Shopify admin, so Polaris does not apply.
// Mannon's own brand tokens are used instead (brand kit §2/§3).
const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100vh",
    margin: 0,
    display: "grid",
    placeItems: "center",
    padding: "2rem",
    background: "linear-gradient(135deg,#eef0ff 0%,#f6f4ff 55%,#eefbe9 100%)",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif',
    color: "#1c1d2b",
  },
  card: {
    maxWidth: "34rem",
    background: "#fff",
    borderRadius: "16px",
    boxShadow: "0 16px 40px rgba(28,29,43,.08)",
    padding: "2.5rem",
  },
  eyebrow: {
    margin: 0,
    fontWeight: 800,
    letterSpacing: "-.02em",
    color: "#4f46e5",
  },
  heading: {
    fontSize: "2rem",
    fontWeight: 800,
    letterSpacing: "-.03em",
    lineHeight: 1.15,
    margin: ".5rem 0 1rem",
    textWrap: "balance",
  },
  accent: { color: "#4f46e5" },
  body: { color: "#6b7280", lineHeight: 1.5, marginBottom: "1.75rem" },
  form: { display: "grid", gap: ".5rem" },
  label: { fontWeight: 600, fontSize: ".9rem" },
  input: {
    padding: ".7rem .85rem",
    borderRadius: "12px",
    border: "1px solid #eceded",
    fontSize: "1rem",
  },
  button: {
    marginTop: ".25rem",
    padding: ".8rem 1rem",
    borderRadius: "12px",
    border: "none",
    background: "#4f46e5",
    color: "#fff",
    fontWeight: 800,
    fontSize: "1rem",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(28,29,43,.06)",
  },
  hint: { color: "#6b7280", fontSize: ".85rem", margin: 0 },
};

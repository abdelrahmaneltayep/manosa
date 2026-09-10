import { money } from "@mannon/pricing-engine";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useTranslation } from "react-i18next";

import { PublicQuote, type PublicQuoteView } from "~/components/orders/PublicQuote";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { dirFor, type Locale } from "~/i18n/config";
import { translate, type Translate } from "~/i18n/translate";
import { formatCurrency } from "~/lib/money";
import {
  acceptQuote,
  declineQuote,
  expireQuote,
  findPublicQuote,
  type QuoteWithLines,
} from "~/lib/quotes/quotes.server";
import { hasExpired, type QuoteState } from "~/lib/quotes/state";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { unauthenticated } from "~/shopify.server";

/**
 * The quote a buyer opens from their email.
 *
 * A public URL on the app's own domain: no session, no App Bridge, no
 * JavaScript. A buyer accepting a price must not depend on a script.
 *
 * The token is the only credential. It is 192 bits of randomness, so a link is
 * not guessable, and it is checked against the clock on every request — a
 * buyer arriving a minute after expiry is refused here, whatever the expiry
 * job has or has not got round to.
 */

interface LoaderData {
  view: PublicQuoteView;
  /** Set after accepting or declining, so the page can say what happened. */
  outcome: "accepted" | "declined" | null;
}

/** Why a buyer cannot act, in their own words. */
function closedReason(quote: QuoteWithLines, now: Date, t: Translate): string | null {
  if (
    hasExpired(quote as unknown as { status: QuoteState; expiresAt: Date | null }, now)
  ) {
    return t("quotes.public.closedExpired");
  }

  switch (quote.status) {
    case "SENT":
      return null;
    case "ACCEPTED":
      return t("quotes.public.closedAccepted");
    case "DECLINED":
      return t("quotes.public.closedDeclined");
    case "EXPIRED":
      return t("quotes.public.closedExpired");
    default:
      // Drafted or brand new: the merchant has not sent it. Saying "not ready"
      // rather than showing prices nobody has been offered yet.
      return t("quotes.public.closedNotSent");
  }
}

function toView(
  quote: QuoteWithLines,
  shopName: string,
  options: { now: Date; t: Translate; locale: Locale },
): PublicQuoteView {
  const { t, now, locale } = options;
  const reason = closedReason(quote, now, t);

  return {
    action: `/q/${quote.publicId}`,
    shopName,
    number: quote.number,
    company: quote.company,
    message: quote.message,
    lines: quote.lines.map((line) => ({
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: formatCurrency(money(line.unitPrice, quote.currencyCode), locale),
      lineTotal: formatCurrency(
        money(line.unitPrice * line.quantity, quote.currencyCode),
        locale,
      ),
    })),
    subtotal: formatCurrency(money(quote.subtotal, quote.currencyCode), locale),
    expiryLabel:
      quote.expiresAt && quote.status === "SENT"
        ? t("quotes.public.expiresOn", {
            date: quote.expiresAt.toISOString().slice(0, 10),
          })
        : null,
    canRespond: reason === null,
    closedReason: reason,
    dir: dirFor(locale),
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const found = await findPublicQuote(params.publicId!);
  // A bad token is not told apart from a missing quote: confirming that a link
  // once existed is information a stranger has no business having.
  if (!found) throw new Response("Quote not found", { status: 404 });

  const locale = detectLocale(request);
  const t = translate(await getFixedT(locale));
  const now = new Date();
  const url = new URL(request.url);

  return shopScope.run(found.shop, async () => {
    // Expired between the job's last run and this request: marked now, so what
    // the buyer reads and what the merchant sees agree.
    if (
      hasExpired(
        found.quote as unknown as { status: QuoteState; expiresAt: Date | null },
        now,
      )
    ) {
      await expireQuote(found.quote.id, { now });
    }

    const record = await db.shop.findUnique({ where: { shop: found.shop } });
    const outcome = url.searchParams.get("s");

    const data: LoaderData = {
      view: toView(found.quote, record?.name ?? found.shop, { now, t, locale }),
      outcome: outcome === "accepted" || outcome === "declined" ? outcome : null,
    };

    return json(data);
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const found = await findPublicQuote(params.publicId!);
  if (!found) throw new Response("Quote not found", { status: 404 });

  const form = await request.formData();
  const intent = (form.get("intent") ?? "").toString();

  return shopScope.run(found.shop, async () => {
    // The buyer is the actor. There is no staff session here, and recording
    // one would put a name against a decision they did not make.
    const actor = { type: "BUYER" as const, id: found.quote.customerId ?? null };

    if (intent === "decline") {
      await declineQuote(found.quote.id, "decline", { actor });
      return redirect(`/q/${params.publicId}?s=declined`);
    }

    if (intent !== "accept") throw new Response("Unknown intent", { status: 400 });

    // Accepting needs the Admin API to build the draft order, and there is no
    // session on a public page — the offline token is loaded for the shop the
    // token resolved to, and nothing else.
    const { admin } = await unauthenticated.admin(found.shop);
    await acceptQuote(found.quote.id, { admin, actor });

    return redirect(`/q/${params.publicId}?s=accepted`);
  });
};

export default function PublicQuoteRoute() {
  const { view, outcome } = useLoaderData<typeof loader>();
  return (
    <>
      {outcome ? <Outcome outcome={outcome} /> : null}
      <PublicQuote view={view as PublicQuoteView} />
    </>
  );
}

function Outcome({ outcome }: { outcome: "accepted" | "declined" }) {
  return (
    <div
      style={{
        maxWidth: "42rem",
        margin: "1.5rem auto 0",
        padding: "0.9rem 1.25rem",
        background: outcome === "accepted" ? "#e7f7ee" : "#f6f6f8",
        border: `1px solid ${outcome === "accepted" ? "#1f8a53" : "#d5d5d5"}`,
        borderRadius: "8px",
        font: "16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <OutcomeText outcome={outcome} />
    </div>
  );
}

function OutcomeText({ outcome }: { outcome: "accepted" | "declined" }) {
  const { t } = useTranslation();
  return <p style={{ margin: 0 }}>{t(`quotes.public.${outcome}Thanks`)}</p>;
}

import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";
import { useTranslation } from "react-i18next";

import { PublicForm, type PublicFormView } from "~/components/forms/PublicForm";
import { detectLocale } from "~/i18n.server";
import { dirFor } from "~/i18n/config";
import { readAppearance, readPublish } from "~/lib/forms/appearance";
import { readDefinition, type Answers } from "~/lib/forms/schema";
import {
  findPublicForm,
  recordView,
  submitForm,
  type SubmissionFile,
} from "~/lib/forms/submissions.server";
import { db } from "~/db.server";
import { frameAncestorsFor } from "~/lib/shop/domains.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { MAX_UPLOAD_BYTES } from "~/lib/forms/schema";

/**
 * The standalone registration page.
 *
 * A public URL on the app's own domain, so a merchant can share a link without
 * touching their theme. No session, no App Bridge, no JavaScript required —
 * this renders and submits as plain HTML.
 */

type Screen = "form" | "thanks" | "already" | "rate_limited" | "closed";

interface LoaderData {
  screen: Screen;
  view: PublicFormView | null;
  formName: string;
  alreadyStatus?: string;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const found = await findPublicForm(params.publicId!);
  if (!found) throw new Response("Form not found", { status: 404 });

  const locale = detectLocale(request);
  const url = new URL(request.url);
  const screen = (url.searchParams.get("s") ?? "form") as Screen;

  return shopScope.run(found.shop, async () => {
    // Only a real view of the form counts towards the conversion rate — not
    // the thank-you page the buyer is redirected to afterwards, and not the
    // re-render that follows a submit with a mistake in it.
    if (request.method === "GET" && screen === "form" && found.form.status === "LIVE") {
      await recordView(found.form.id);
    }

    const data: LoaderData = {
      screen: found.form.status === "LIVE" ? screen : "closed",
      formName: found.form.name,
      alreadyStatus: url.searchParams.get("status") ?? undefined,
      view:
        found.form.status === "LIVE" && screen === "form"
          ? {
              action: `/f/${found.form.publicId}`,
              name: found.form.name,
              intro: null,
              fields: readDefinition(found.form.fields).fields,
              appearance: readAppearance(found.form.appearance),
              answers: {},
              issues: [],
              renderedAt: Date.now(),
              dir: dirFor(locale),
            }
          : null,
    };

    return json(data, { headers: { "content-security-policy": await csp(found.shop) } });
  });
};

/** Only the merchant's own storefront may frame their application form. */
async function csp(shop: string): Promise<string> {
  const record = await db.shop.findUnique({
    where: { shop },
    select: { primaryDomain: true },
  });
  return frameAncestorsFor(shop, record?.primaryDomain ?? null);
}

export const headers: HeadersFunction = ({ loaderHeaders }) => ({
  // Re-emitted from the loader response, because the document response does
  // not inherit loader headers on its own.
  "Content-Security-Policy":
    loaderHeaders.get("content-security-policy") ?? "frame-ancestors 'none'",
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const found = await findPublicForm(params.publicId!);
  if (!found) throw new Response("Form not found", { status: 404 });

  const locale = detectLocale(request);
  const form = await request.formData();

  const answers: Answers = {};
  const files: SubmissionFile[] = [];

  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      answers[key] = value;
      continue;
    }
    if (!value.size) continue;
    // Bounded before the bytes are read: a 400 MB upload should not become 400
    // MB of this process's memory on the way to being rejected.
    if (value.size > MAX_UPLOAD_BYTES) {
      files.push({
        fieldKey: key,
        fileName: value.name,
        contentType: value.type,
        bytes: new Uint8Array(value.size),
      });
      continue;
    }
    files.push({
      fieldKey: key,
      fileName: value.name,
      contentType: value.type,
      bytes: new Uint8Array(await value.arrayBuffer()),
    });
  }

  return shopScope.run(found.shop, async () => {
    const result = await submitForm({
      form: found.form,
      answers,
      files,
      headers: request.headers,
    });

    if (result.ok) {
      const publish = readPublish(found.form.publish);
      // A merchant's own thank-you page wins, when they set one.
      if (publish.redirectUrl) return redirect(publish.redirectUrl);
      return redirect(`/f/${found.form.publicId}?s=thanks`);
    }

    if (result.kind === "already_applied") {
      return redirect(
        `/f/${found.form.publicId}?s=already&status=${result.status.toLowerCase()}`,
      );
    }
    if (result.kind === "rate_limited") {
      return redirect(`/f/${found.form.publicId}?s=rate_limited`);
    }
    if (result.kind === "form_not_live") {
      return redirect(`/f/${found.form.publicId}?s=closed`);
    }

    // Re-render with the answers still in place. Losing what a buyer typed
    // because one field was wrong is how an application becomes abandoned.
    const data: LoaderData = {
      screen: "form",
      formName: found.form.name,
      view: {
        action: `/f/${found.form.publicId}`,
        name: found.form.name,
        intro: null,
        fields: readDefinition(found.form.fields).fields,
        appearance: readAppearance(found.form.appearance),
        answers,
        issues: result.issues,
        renderedAt: Date.now(),
        dir: dirFor(locale),
      },
    };

    return json(data, {
      status: 422,
      headers: { "content-security-policy": await csp(found.shop) },
    });
  });
};

export default function PublicFormPage() {
  // Without JavaScript a submit is a document POST: Remix runs the action, then
  // re-runs the loader and renders. The loader knows nothing about what was
  // typed or what was wrong, so the action's answer has to win — reading only
  // the loader hands the buyer a blank form and no explanation.
  const loaderData = useLoaderData<typeof loader>() as LoaderData;
  const actionData = useActionData<typeof action>() as LoaderData | undefined;
  const data = actionData ?? loaderData;
  const { t } = useTranslation();

  if (data.screen === "form" && data.view) {
    return (
      <main style={{ padding: "2rem 1rem" }}>
        <PublicForm view={data.view} />
        <FrameHeightReporter />
      </main>
    );
  }

  const key =
    data.screen === "already"
      ? "already"
      : data.screen === "rate_limited"
        ? "rateLimited"
        : data.screen === "closed"
          ? "closed"
          : "thanks";

  return (
    <main style={{ padding: "3rem 1rem", maxWidth: "38rem", margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem" }}>{t(`forms.public.${key}Heading`)}</h1>
      <p>{t(`forms.public.${key}Body`, { form: data.formName })}</p>
      {data.screen === "already" && data.alreadyStatus ? (
        <p>
          <strong>{t(`forms.public.status.${data.alreadyStatus}`)}</strong>
        </p>
      ) : null}
    </main>
  );
}

/**
 * Tells a theme block how tall the form is, so the frame has no inner
 * scrollbar. Pure enhancement: without it the frame is scrollable, and without
 * JavaScript at all the form still renders and submits.
 */
function FrameHeightReporter() {
  const script = `(function(){
    if (window.parent === window) return;
    var send = function () {
      window.parent.postMessage(
        { type: "mannon:height", height: document.documentElement.scrollHeight },
        "*"
      );
    };
    send();
    window.addEventListener("load", send);
    if (window.ResizeObserver) new ResizeObserver(send).observe(document.body);
  })();`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

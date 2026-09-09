import { PassThrough } from "node:stream";

import type { AppLoadContext, EntryContext } from "@remix-run/node";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { isbot } from "isbot";
import { I18nextProvider } from "react-i18next";
import { renderToPipeableStream } from "react-dom/server";

import { detectLocale } from "~/i18n.server";
import { createI18n } from "~/i18n/i18next";
import { addDocumentResponseHeaders } from "~/shopify.server";

const ABORT_DELAY = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  // Sets the Content-Security-Policy frame-ancestors that lets the Shopify
  // admin embed us, per shop. Not applied to the buyer-facing form pages: they
  // are framed by the merchant's storefront, not by the admin, and the route
  // sets its own frame-ancestors naming that storefront.
  if (!new URL(request.url).pathname.startsWith("/f/")) {
    addDocumentResponseHeaders(request, responseHeaders);
  }

  // One instance per request: two shops rendering in different languages at
  // the same time must not race on a shared global language.
  const i18n = await createI18n(detectLocale(request));

  const userAgent = request.headers.get("user-agent");
  const callbackName = userAgent && isbot(userAgent) ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    let didError = false;

    const { pipe, abort } = renderToPipeableStream(
      <I18nextProvider i18n={i18n}>
        <RemixServer context={remixContext} url={request.url} abortDelay={ABORT_DELAY} />
      </I18nextProvider>,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: didError ? 500 : responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          didError = true;
          console.error(error);
        },
      },
    );

    setTimeout(abort, ABORT_DELAY);
  });
}

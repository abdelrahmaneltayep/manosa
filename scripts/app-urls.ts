/**
 * `npm run config:urls` — point `shopify.app.toml` at the deployed app.
 *
 * Run before `shopify app deploy`, which is why `npm run deploy` runs it for
 * you. Reads `SHOPIFY_APP_URL` — the same variable the app refuses to boot
 * without and uses for these exact callbacks at runtime — or `--url=<origin>`.
 *
 * It rewrites origins and never paths: `/auth/callback` and `/proxy` are this
 * app's own routes, not something a deployer should have to retype.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { whyNotDeployable, withAppUrl } from "~/lib/release/app-urls";

const flag = process.argv.find((one) => one.startsWith("--url="))?.slice("--url=".length);
const appUrl = (flag ?? process.env.SHOPIFY_APP_URL ?? "").trim();

if (!appUrl) {
  process.stderr.write(
    "SHOPIFY_APP_URL is not set, and no --url= was given.\n\n" +
      "This is the origin Shopify will call for OAuth, webhooks and the App\n" +
      "Proxy. There is no safe default: a guess here is a config that looks\n" +
      "deployed and is not.\n",
  );
  process.exit(1);
}

const reason = whyNotDeployable(appUrl);
if (reason) {
  process.stderr.write(`${reason}\n\nNothing was written.\n`);
  process.exit(1);
}

const path = resolve(process.cwd(), "shopify.app.toml");
const { toml, changed } = withAppUrl(readFileSync(path, "utf8"), appUrl);

if (changed.length === 0) {
  process.stdout.write(`shopify.app.toml already points at ${appUrl}.\n`);
  process.exit(0);
}

writeFileSync(path, toml);
process.stdout.write(
  [
    `shopify.app.toml now points at ${appUrl}:`,
    ...changed.map((one) => `  ${one.key}\n    ${one.from}\n    → ${one.to}`),
    "",
    "Commit this, or run `shopify app deploy` and let the diff be reviewed.",
    "",
  ].join("\n"),
);

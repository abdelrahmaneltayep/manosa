/**
 * `npm run check:app` — refuse to deploy into somebody else's app.
 *
 * Runs inside `npm run deploy`, before `shopify app deploy` is reached.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { whyNotDeployable } from "~/lib/release/app-identity";

const toml = readFileSync(resolve(process.cwd(), "shopify.app.toml"), "utf8");
const problem = whyNotDeployable(toml, process.env.SHOPIFY_APP_CLIENT_ID);

if (problem) {
  process.stderr.write(`Refusing to deploy.\n\n${problem.reason}\n\n${problem.remedy}\n`);
  process.exit(1);
}

process.stdout.write("App identity is pinned. Deploying to that app and no other.\n");

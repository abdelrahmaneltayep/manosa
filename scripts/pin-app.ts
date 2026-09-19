/**
 * `npm run pin:app -- <client_id>` — name the one app this repo deploys to.
 *
 * `shopify app config link` writes this line itself, so the usual path is to
 * run that on a machine that can reach Shopify and commit what it produced.
 * This exists for the other case: the link ran somewhere else, and the value
 * has to get into the file here without a hand edit and without a typo that
 * `check:app` would then happily accept.
 *
 * It refuses to overwrite a client_id that is already pinned and different.
 * That is not a formality — the value names the app a release goes to, and a
 * release cannot be taken back from the merchants who already have it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  declaredHandle,
  pinClientId,
  pinnedClientId,
  whyNotAClientId,
} from "~/lib/release/app-identity";

const args = process.argv.slice(2).filter((one) => one !== "--");
const force = args.includes("--force");
const given = args.find((one) => !one.startsWith("-"))?.trim() ?? "";

if (!given) {
  process.stderr.write(
    "Usage: npm run pin:app -- <client_id> [--force]\n\n" +
      "The client_id of the app this repository deploys to. `shopify app config\n" +
      "link` prints it and writes it; this is for getting it here afterwards.\n",
  );
  process.exit(1);
}

const malformed = whyNotAClientId(given);
if (malformed) {
  process.stderr.write(
    `${malformed}\n\nCheck it against the app before pinning anything.\n`,
  );
  process.exit(1);
}

const path = resolve(process.cwd(), "shopify.app.toml");
const toml = readFileSync(path, "utf8");
const already = pinnedClientId(toml);

if (already && already !== given && !force) {
  process.stderr.write(
    `shopify.app.toml is already pinned to ${already}.\n\n` +
      `Pinning ${given} would point this repository at a different app. If that\n` +
      "is deliberate, re-run with --force — and know that whatever was released\n" +
      "to the old app stays released.\n",
  );
  process.exit(1);
}

const next = pinClientId(toml, given);
writeFileSync(path, next);

process.stdout.write(
  [
    `Pinned. This repository now deploys to one app and no other:`,
    ``,
    `  handle     ${declaredHandle(next) ?? "?"}`,
    `  client_id  ${given}`,
    ``,
    `Check that against the org and app \`shopify app config link\` named — it is`,
    `the only thing standing between a release here and a release somewhere else.`,
    `Then: npm run check:app`,
    ``,
  ].join("\n"),
);

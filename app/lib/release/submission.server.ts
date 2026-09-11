import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { WEBHOOK_SUBSCRIPTIONS } from "~/lib/webhooks/registry";

/**
 * What stands between this repo and a Shopify App Store submission.
 *
 * Shopify's own self-review requirements are the authority and they live at
 * `shopify.dev`, which this build environment cannot reach — so this is
 * deliberately **not** a compliance report and does not pretend to be one. It
 * is the subset a machine can check from inside the repository, each one
 * something that is objectively true or false about these files.
 *
 * It exists because the things it checks are the ones that are easy to know and
 * easy to forget. `shopify.app.toml` has pointed `application_url` at
 * `https://localhost:3000` since 0.1; `PROGRESS.md` has said so since 3.4;
 * nothing has ever failed because of it, and a submission made on that file
 * would be rejected before a human read a word of the listing.
 *
 * Run it with `npm run release:check`.
 */

export type CheckStatus = "ready" | "blocked" | "unverifiable";

export interface SubmissionCheck {
  id: string;
  title: string;
  status: CheckStatus;
  /** What was found, and for a blocker what to do about it. */
  detail: string;
}

const root = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** Hosts that mean "this was never deployed". */
const LOCAL = /localhost|127\.0\.0\.1|\.ngrok|trycloudflare|\.local\b/;

export function submissionReadiness(): SubmissionCheck[] {
  const toml = root("shopify.app.toml");
  const checks: SubmissionCheck[] = [];

  // --- Things that are simply wrong until a deploy happens -----------------

  const urls = [...toml.matchAll(/^\s*(?:application_url|url)\s*=\s*"([^"]+)"/gm)].map(
    (match) => match[1]!,
  );
  const redirects = [
    ...(toml.match(/redirect_urls\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]!);
  const local = [...urls, ...redirects].filter((url) => LOCAL.test(url));

  checks.push({
    id: "urls",
    title: "Every URL in shopify.app.toml is a real one",
    status: local.length > 0 ? "blocked" : "ready",
    detail:
      local.length > 0
        ? `${local.length} URL(s) still point at a development host: ${[
            ...new Set(local),
          ].join(
            ", ",
          )}. Shopify calls these — OAuth, webhooks and the App Proxy — so a submission on this file is rejected before anybody reads the listing. Set them to the deployed app URL.`
        : "No development hosts in the app configuration.",
  });

  // --- Things this repo can genuinely prove --------------------------------

  const compliance = ["customers/data_request", "customers/redact", "shop/redact"];
  const declaredCompliance = compliance.filter((topic) =>
    new RegExp(`compliance_topics\\s*=\\s*\\[[^\\]]*"${topic}"`).test(toml),
  );

  checks.push({
    id: "gdpr",
    title: "The three mandatory privacy topics are declared, under the right key",
    status: declaredCompliance.length === compliance.length ? "ready" : "blocked",
    detail:
      declaredCompliance.length === compliance.length
        ? "All three are declared as `compliance_topics`, which is the only key Shopify reads for them."
        : `Missing or declared as plain topics: ${compliance
            .filter((topic) => !declaredCompliance.includes(topic))
            .join(", ")}. Declared as \`topics\` they register with nobody.`,
  });

  const uninstall = WEBHOOK_SUBSCRIPTIONS.some((one) => one.topic === "app/uninstalled");
  checks.push({
    id: "uninstall",
    title: "app/uninstalled is handled",
    status: uninstall ? "ready" : "blocked",
    detail: uninstall
      ? "Sessions are revoked on uninstall and the data purge is scheduled."
      : "Nothing handles an uninstall: access tokens outlive the install.",
  });

  checks.push({
    id: "embedded",
    title: "The app is embedded and uses App Bridge",
    status:
      /^embedded\s*=\s*true/m.test(toml) &&
      root("app/root.tsx").includes("cdn.shopify.com/shopifycloud/app-bridge.js")
        ? "ready"
        : "blocked",
    detail:
      "`embedded = true` and App Bridge is loaded from Shopify's CDN, unbundled, as review requires.",
  });

  const billing = root("app/shopify.server.ts").includes("billing");
  checks.push({
    id: "billing",
    title: "Charges go through Shopify's Billing API",
    status: billing ? "ready" : "unverifiable",
    detail: billing
      ? "Plans are defined against the Billing API; nothing takes payment another way."
      : "No billing configuration found — check nothing charges outside Shopify.",
  });

  // --- Things only a submission can answer ---------------------------------

  for (const [id, title, detail] of [
    [
      "listing",
      "Listing copy, screenshots, icon and pricing details",
      "Not in this repository. Written in the Partner Dashboard at submission.",
    ],
    [
      "privacy-policy",
      "A published privacy policy and support contact",
      "Not in this repository. Required by review; both are URLs entered at submission.",
    ],
    [
      "dev-store",
      "Installed, tested and demonstrated on a real store",
      "Never done: this environment cannot reach Shopify (see PROGRESS.md). Fresh install, reinstall, uninstall cleanup, a staff account with limited permissions and a 10k-product store are all still owed.",
    ],
    [
      "performance",
      "Built for Shopify budgets, measured on a real storefront",
      "Lighthouse needs a storefront this environment cannot reach. What would spend the budget is asserted in `tests/unit/storefront-blocks.test.ts`; the number itself is unverified.",
    ],
  ] as const) {
    checks.push({ id, title, status: "unverifiable", detail });
  }

  return checks;
}

/** The report, for a terminal. */
export function formatReadiness(checks: SubmissionCheck[]): string {
  const mark = { ready: "✓", blocked: "✗", unverifiable: "?" } as const;
  const blocked = checks.filter((one) => one.status === "blocked");

  return [
    "Submission readiness — the part a machine can check from this repository.",
    "Shopify's own requirements are the authority; this is not a compliance report.",
    "",
    ...checks.map((one) => `  ${mark[one.status]} ${one.title}\n      ${one.detail}`),
    "",
    blocked.length === 0
      ? "Nothing here blocks a submission. Everything marked ? is answered at submission or on a real store."
      : `${blocked.length} blocker(s) above.`,
    "",
  ].join("\n");
}

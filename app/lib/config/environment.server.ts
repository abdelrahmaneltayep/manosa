/**
 * What this app needs to be told before it can be trusted to run.
 *
 * Every one of these was read with a `!` or a `?? ""` scattered through the
 * code, which means a deployment missing one did not fail — it ran, wrongly,
 * and said nothing. The worst of them is `SHOPIFY_API_SECRET`: defaulted to an
 * empty string, it does not stop webhook verification, it makes it *wrong*.
 * An empty key still produces a deterministic HMAC, so anybody who knows the
 * app is misconfigured can sign a delivery for any shop and have it handled.
 *
 * So the rule here is the one this repo keeps arriving at: a thing that cannot
 * be done correctly is refused rather than approximated. In production a
 * missing required variable throws at boot with the whole list, because ten
 * minutes of a failed deploy is cheaper than an afternoon of a running one
 * that is quietly forging its own webhooks. In development it warns, because a
 * contributor who has not filled in `.env` yet should still get a dev server.
 *
 * The optional ones are listed too, with what stops working. They do not fail
 * a boot; they are reported by `/healthz/ready` so an operator can see, on one
 * page, which parts of the product are switched off in their environment.
 */

export interface EnvironmentVariable {
  name: string;
  /** Missing this one is not a degradation; it is a wrong answer. */
  required: boolean;
  /** What is broken without it, in the words an operator needs. */
  breaks: string;
}

export const ENVIRONMENT: readonly EnvironmentVariable[] = [
  {
    name: "DATABASE_URL",
    required: true,
    breaks: "Nothing works: every page and every job reads the database.",
  },
  {
    name: "SHOPIFY_API_KEY",
    required: true,
    breaks: "No merchant can install or open the app.",
  },
  {
    name: "SHOPIFY_API_SECRET",
    required: true,
    breaks:
      "Webhook and App Proxy signatures cannot be verified. An empty secret " +
      "does not refuse them — it verifies them against an empty key, so a " +
      "forged delivery for any shop is accepted.",
  },
  {
    name: "SHOPIFY_APP_URL",
    required: true,
    breaks: "OAuth redirects and every webhook callback point at nothing.",
  },
  {
    name: "SCOPES",
    required: true,
    breaks: "The app asks for no permissions and every Admin API call is refused.",
  },
  {
    name: "JOBS_RUNNER_TOKEN",
    required: false,
    breaks:
      "No background work runs — which includes the GDPR purge this app " +
      "promises a merchant within 48 hours of uninstalling, the retention " +
      "sweeps, quote expiry and the daily briefing.",
  },
  {
    name: "SHOPIFY_DISCOUNT_FUNCTION_ID",
    required: false,
    breaks: "Wholesale prices are not applied at checkout.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    required: false,
    breaks: "Every ✦ feature is unavailable. The product works without it.",
  },
  {
    name: "MANNON_RESEND_API_KEY",
    required: false,
    breaks:
      "No email is sent. Approvals, rejections and reminders are recorded and " +
      "the screen says they could not be delivered.",
  },
] as const;

let announced = false;

const isSet = (name: string) => (process.env[name] ?? "").trim().length > 0;

export interface EnvironmentReport {
  missingRequired: EnvironmentVariable[];
  missingOptional: EnvironmentVariable[];
  ok: boolean;
}

export function checkEnvironment(): EnvironmentReport {
  const missingRequired = ENVIRONMENT.filter((one) => one.required && !isSet(one.name));
  const missingOptional = ENVIRONMENT.filter((one) => !one.required && !isSet(one.name));

  return { missingRequired, missingOptional, ok: missingRequired.length === 0 };
}

export class EnvironmentIncomplete extends Error {
  constructor(readonly missing: EnvironmentVariable[]) {
    super(
      [
        "Mannon cannot start. These environment variables are not set:",
        ...missing.map((one) => `  ${one.name} — ${one.breaks}`),
        "",
        "See .env.example. Nothing here has a safe default.",
      ].join("\n"),
    );
    this.name = "EnvironmentIncomplete";
  }
}

/**
 * Called once, as the server starts.
 *
 * Throws in production and warns everywhere else. Tests set what they need and
 * would otherwise have to set everything.
 */
export function assertEnvironment(
  env: string | undefined = process.env.NODE_ENV,
): EnvironmentReport {
  const report = checkEnvironment();

  if (report.missingRequired.length > 0) {
    if (env === "production") throw new EnvironmentIncomplete(report.missingRequired);

    console.warn(
      `[mannon] not configured: ${report.missingRequired
        .map((one) => one.name)
        .join(", ")}. This would refuse to start in production.`,
    );
  }

  // Once per process, and never under test: the point is to tell an operator
  // what is switched off in their environment, not to put nine lines in front
  // of every test run that imports this module.
  if (env !== "test" && !announced) {
    announced = true;
    for (const one of report.missingOptional) {
      console.info(`[mannon] ${one.name} is not set. ${one.breaks}`);
    }
  }

  return report;
}

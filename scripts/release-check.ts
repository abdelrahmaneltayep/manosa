/**
 * `npm run release:check` — what stands between this repo and a submission.
 *
 * Exits non-zero when something in these files would be rejected, so it can sit
 * in a deploy pipeline. It never claims to be Shopify's own review: those
 * requirements live at shopify.dev and are the authority.
 */
import { formatReadiness, submissionReadiness } from "~/lib/release/submission.server";

const checks = submissionReadiness();
process.stdout.write(formatReadiness(checks));
process.exit(checks.some((one) => one.status === "blocked") ? 1 : 0);

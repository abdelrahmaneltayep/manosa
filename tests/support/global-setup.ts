import { execSync } from "node:child_process";

/**
 * Bring the test database up to the current migration set once per run.
 * `migrate deploy` is idempotent, so a warm database costs a few milliseconds.
 */
export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgresql://mannon:mannon@localhost:5432/mannon_test?schema=public";

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}

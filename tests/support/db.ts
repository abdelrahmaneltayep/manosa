import { prismaBase } from "~/db.server";

/**
 * Wipe every table between test cases. Truncate rather than delete so the
 * order of foreign keys does not matter as the schema grows.
 */
const TABLES = ["Session", "Shop", "AuditLog", "WebhookDelivery", "ScheduledJob"];

export async function resetDatabase() {
  await prismaBase.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export { prismaBase };

import { prismaBase } from "~/db.server";

/**
 * Wipe every table between test cases. Truncate rather than delete so the
 * order of foreign keys does not matter as the schema grows.
 */
export async function resetDatabase() {
  await prismaBase.$executeRawUnsafe(
    `TRUNCATE TABLE "Session", "Shop" RESTART IDENTITY CASCADE`,
  );
}

export { prismaBase };

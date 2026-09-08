import { Prisma } from "@prisma/client";

import { prismaBase } from "~/db.server";

/**
 * Wipe every table between test cases.
 *
 * The table list comes from the schema rather than being maintained by hand:
 * a hand-written list is a registration step to forget, and forgetting it
 * leaks rows between tests, which shows up as a dozen unrelated failures.
 * Truncate rather than delete so foreign-key order does not matter.
 */
const TABLES = Prisma.dmmf.datamodel.models.map(
  (model) => `"${model.dbName ?? model.name}"`,
);

export async function resetDatabase() {
  await prismaBase.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export { prismaBase };

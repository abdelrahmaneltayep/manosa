/**
 * Limits the Translations page shows a merchant and the route enforces.
 *
 * Plain, not `.server`: the page renders the number into its own error copy,
 * and a component that imported it from `fill.server.ts` would pull Prisma and
 * the Anthropic SDK into the client build. `model.ts` is here for the same
 * reason.
 */

/**
 * A language's wording is a few dozen kilobytes. Anything far past that was
 * produced by something other than this page's export.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

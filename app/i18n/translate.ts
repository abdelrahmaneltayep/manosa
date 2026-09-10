import type { TFunction } from "i18next";

/**
 * What a view-model needs of a translator.
 *
 * i18next's `TFunction` is heavily overloaded so that it can narrow return
 * types from a typed catalog. Those overloads do not structurally satisfy a
 * plain `(key, params) => string`, which is all a view-model wants — so the
 * adapter below makes the conversion once, in one place, instead of every call
 * site reaching for a cast.
 */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Narrow a request's `TFunction` to what the view-models take. */
export function translate(t: TFunction): Translate {
  return (key, params) => t(key, params ?? {});
}

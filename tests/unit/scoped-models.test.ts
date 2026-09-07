import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { __testing } from "~/lib/tenant/shop-scope.server";

const { scopedModelNames, UNSCOPED_MODELS } = __testing;

describe("scoped model discovery", () => {
  it("scopes every model that carries a shop column", () => {
    expect(scopedModelNames().has("Shop")).toBe(true);
  });

  it("honours the explicit exemption list", () => {
    expect(UNSCOPED_MODELS.has("Session")).toBe(true);
    expect(scopedModelNames().has("Session")).toBe(false);
  });

  /**
   * The guard rail that matters as the schema grows: a new merchant-data table
   * is either scoped, or exempted on purpose with a reason in the source. This
   * fails the moment someone adds a table with no `shop` column and no
   * exemption, which is how tenant leaks get introduced.
   */
  it("leaves no model both unscoped and unexempted", () => {
    const scoped = scopedModelNames();
    const unaccounted = Prisma.dmmf.datamodel.models
      .map((model) => model.name)
      .filter((name) => !scoped.has(name) && !UNSCOPED_MODELS.has(name));

    expect(unaccounted).toEqual([]);
  });
});

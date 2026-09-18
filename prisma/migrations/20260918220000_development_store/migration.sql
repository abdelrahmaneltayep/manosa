-- A development store can only ever take a test charge. Knowing which stores
-- those are is what lets one deployment answer the question per shop, instead
-- of an environment variable that is either right for the dev store or right
-- for everybody else.
ALTER TABLE "Shop" ADD COLUMN "isDevelopmentStore" BOOLEAN NOT NULL DEFAULT false;

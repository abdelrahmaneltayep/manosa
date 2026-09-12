-- A child row may only point at a parent in its own shop.
--
-- The tenant guard rewrites a `where` and stamps a `create`, and neither of
-- those can stop a foreign key pointing across the line: from shop B you could
-- create an OrderLine whose orderId belongs to shop A, and once such a row
-- exists a relation read hands it over — an `include` is resolved inside one
-- SQL statement and is never a separate model operation the guard can filter.
--
-- So this moves the check to the one place that cannot be forgotten. Each FK
-- becomes composite on (shop, parentId), which Postgres itself enforces.
--
-- `Customer.groupId` is deliberately NOT converted: it is `ON DELETE SET NULL`
-- and a composite SET NULL would try to null `shop`, which is NOT NULL. That
-- relation stays single-column and is validated in the application, where
-- `changeGroup`, `decideApplication` and `deleteGroup` each resolve the group
-- through a scoped read first.

-- Parents: a composite unique for the FKs below to reference.
CREATE UNIQUE INDEX "RegistrationForm_shop_id_key" ON "RegistrationForm"("shop", "id");
CREATE UNIQUE INDEX "FormSubmission_shop_id_key" ON "FormSubmission"("shop", "id");
CREATE UNIQUE INDEX "Order_shop_id_key" ON "Order"("shop", "id");
CREATE UNIQUE INDEX "Quote_shop_id_key" ON "Quote"("shop", "id");
CREATE UNIQUE INDEX "CustomerGroup_shop_id_key" ON "CustomerGroup"("shop", "id");
CREATE UNIQUE INDEX "AgentConversation_shop_id_key" ON "AgentConversation"("shop", "id");

-- FormSubmission -> RegistrationForm
ALTER TABLE "FormSubmission" DROP CONSTRAINT "FormSubmission_formId_fkey";
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_shop_formId_fkey"
  FOREIGN KEY ("shop", "formId") REFERENCES "RegistrationForm"("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FormEvent -> RegistrationForm
ALTER TABLE "FormEvent" DROP CONSTRAINT "FormEvent_formId_fkey";
ALTER TABLE "FormEvent" ADD CONSTRAINT "FormEvent_shop_formId_fkey"
  FOREIGN KEY ("shop", "formId") REFERENCES "RegistrationForm"("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FormUpload -> FormSubmission
ALTER TABLE "FormUpload" DROP CONSTRAINT "FormUpload_submissionId_fkey";
ALTER TABLE "FormUpload" ADD CONSTRAINT "FormUpload_shop_submissionId_fkey"
  FOREIGN KEY ("shop", "submissionId") REFERENCES "FormSubmission"("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- OrderLine -> Order
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_orderId_fkey";
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_shop_orderId_fkey"
  FOREIGN KEY ("shop", "orderId") REFERENCES "Order"("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Payment -> Order
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_orderId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shop_orderId_fkey"
  FOREIGN KEY ("shop", "orderId") REFERENCES "Order"("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- QuoteLine -> Quote
ALTER TABLE "QuoteLine" DROP CONSTRAINT "QuoteLine_quoteId_fkey";
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_shop_quoteId_fkey"
  FOREIGN KEY ("shop", "quoteId") REFERENCES "Quote"("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- OrderLimit -> CustomerGroup
ALTER TABLE "OrderLimit" DROP CONSTRAINT "OrderLimit_groupId_fkey";
ALTER TABLE "OrderLimit" ADD CONSTRAINT "OrderLimit_shop_groupId_fkey"
  FOREIGN KEY ("shop", "groupId") REFERENCES "CustomerGroup"("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AgentMessage -> AgentConversation
ALTER TABLE "AgentMessage" DROP CONSTRAINT "AgentMessage_conversationId_fkey";
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_shop_conversationId_fkey"
  FOREIGN KEY ("shop", "conversationId") REFERENCES "AgentConversation"("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

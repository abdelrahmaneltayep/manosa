-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "currentQuantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "currentTotal" INTEGER NOT NULL DEFAULT 0;

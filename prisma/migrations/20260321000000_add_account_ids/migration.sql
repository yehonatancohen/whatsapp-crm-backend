-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

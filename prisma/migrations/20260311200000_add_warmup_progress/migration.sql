-- CreateTable
CREATE TABLE "WarmupProgress" (
    "phoneNumber" TEXT NOT NULL,
    "warmupLevel" "WarmupLevel" NOT NULL DEFAULT 'L1',
    "warmupStartedAt" TIMESTAMP(3),
    "messagesSentToday" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmupProgress_pkey" PRIMARY KEY ("phoneNumber")
);

-- Migrate data
INSERT INTO "WarmupProgress" ("phoneNumber", "warmupLevel", "warmupStartedAt", "messagesSentToday", "lastMessageAt", "createdAt", "updatedAt")
SELECT "phoneNumber", "warmupLevel", "warmupStartedAt", "messagesSentToday", "lastMessageAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Account" 
WHERE "phoneNumber" IS NOT NULL
ON CONFLICT ("phoneNumber") DO NOTHING;

-- DropIndex
DROP INDEX "Account_warmupLevel_idx";

-- AlterTable
ALTER TABLE "Account" DROP COLUMN "lastMessageAt",
DROP COLUMN "messagesSentToday",
DROP COLUMN "warmupLevel",
DROP COLUMN "warmupStartedAt";

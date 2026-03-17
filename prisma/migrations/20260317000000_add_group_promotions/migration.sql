-- CreateEnum
CREATE TYPE "PromotionSendStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "GroupPromotion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sendTimes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
    "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dailyLimitPerAccount" INTEGER NOT NULL DEFAULT 50,
    "messagesPerMinute" INTEGER NOT NULL DEFAULT 2,
    "lastSentAt" TIMESTAMP(3),
    "totalSendCount" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupPromotionMessage" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "promotionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupPromotionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupPromotionGroup" (
    "id" TEXT NOT NULL,
    "groupJid" TEXT NOT NULL,
    "groupName" TEXT,
    "promotionId" TEXT NOT NULL,

    CONSTRAINT "GroupPromotionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupPromotionLog" (
    "id" TEXT NOT NULL,
    "status" "PromotionSendStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedText" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "groupJid" TEXT NOT NULL,
    "groupName" TEXT,
    "accountId" TEXT,
    "messageId" TEXT,
    "promotionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupPromotionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupPromotion_userId_idx" ON "GroupPromotion"("userId");

-- CreateIndex
CREATE INDEX "GroupPromotion_isActive_idx" ON "GroupPromotion"("isActive");

-- CreateIndex
CREATE INDEX "GroupPromotionMessage_promotionId_idx" ON "GroupPromotionMessage"("promotionId");

-- CreateIndex
CREATE INDEX "GroupPromotionGroup_promotionId_idx" ON "GroupPromotionGroup"("promotionId");

-- CreateIndex
CREATE INDEX "GroupPromotionLog_promotionId_createdAt_idx" ON "GroupPromotionLog"("promotionId", "createdAt");

-- CreateIndex
CREATE INDEX "GroupPromotionLog_accountId_createdAt_idx" ON "GroupPromotionLog"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "GroupPromotionLog_status_idx" ON "GroupPromotionLog"("status");

-- AddForeignKey
ALTER TABLE "GroupPromotion" ADD CONSTRAINT "GroupPromotion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupPromotionMessage" ADD CONSTRAINT "GroupPromotionMessage_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "GroupPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupPromotionGroup" ADD CONSTRAINT "GroupPromotionGroup_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "GroupPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupPromotionLog" ADD CONSTRAINT "GroupPromotionLog_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "GroupPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupPromotionLog" ADD CONSTRAINT "GroupPromotionLog_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "GroupPromotionMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

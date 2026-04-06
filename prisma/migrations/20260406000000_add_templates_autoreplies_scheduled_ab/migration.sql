-- CreateEnum
CREATE TYPE "AutoReplyMatchType" AS ENUM ('EXACT', 'CONTAINS', 'STARTS_WITH', 'REGEX');

-- CreateEnum
CREATE TYPE "ScheduledMessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'AUTO_REPLY_TRIGGERED';
ALTER TYPE "ActivityType" ADD VALUE 'SCHEDULED_MESSAGE_SENT';
ALTER TYPE "ActivityType" ADD VALUE 'TEMPLATE_CREATED';

-- AlterTable: Add variantId to CampaignMessage
ALTER TABLE "CampaignMessage" ADD COLUMN "variantId" TEXT;

-- CreateTable: MessageTemplate
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AutoReply
CREATE TABLE "AutoReply" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "matchType" "AutoReplyMatchType" NOT NULL DEFAULT 'CONTAINS',
    "matchValue" TEXT NOT NULL,
    "replyMessage" TEXT NOT NULL,
    "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onlyPrivate" BOOLEAN NOT NULL DEFAULT true,
    "cooldownSec" INTEGER NOT NULL DEFAULT 60,
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ScheduledMessage
CREATE TABLE "ScheduledMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatName" TEXT,
    "body" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledMessageStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CampaignVariant
CREATE TABLE "CampaignVariant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "messageTemplate" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 50,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "campaignId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageTemplate_userId_idx" ON "MessageTemplate"("userId");
CREATE INDEX "MessageTemplate_category_idx" ON "MessageTemplate"("category");
CREATE UNIQUE INDEX "MessageTemplate_userId_name_key" ON "MessageTemplate"("userId", "name");

-- CreateIndex
CREATE INDEX "AutoReply_userId_idx" ON "AutoReply"("userId");
CREATE INDEX "AutoReply_isActive_idx" ON "AutoReply"("isActive");

-- CreateIndex
CREATE INDEX "ScheduledMessage_userId_idx" ON "ScheduledMessage"("userId");
CREATE INDEX "ScheduledMessage_accountId_idx" ON "ScheduledMessage"("accountId");
CREATE INDEX "ScheduledMessage_status_scheduledAt_idx" ON "ScheduledMessage"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "CampaignVariant_campaignId_idx" ON "CampaignVariant"("campaignId");
CREATE INDEX "CampaignMessage_variantId_idx" ON "CampaignMessage"("variantId");

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutoReply" ADD CONSTRAINT "AutoReply_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledMessage" ADD CONSTRAINT "ScheduledMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledMessage" ADD CONSTRAINT "ScheduledMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignVariant" ADD CONSTRAINT "CampaignVariant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignMessage" ADD CONSTRAINT "CampaignMessage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "CampaignVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "WarmupContactSeen" (
    "senderAccountId" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarmupContactSeen_pkey" PRIMARY KEY ("senderAccountId","recipientPhone")
);

-- CreateIndex
CREATE INDEX "WarmupContactSeen_senderAccountId_idx" ON "WarmupContactSeen"("senderAccountId");

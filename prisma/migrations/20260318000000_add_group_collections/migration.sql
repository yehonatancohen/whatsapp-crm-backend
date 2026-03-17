-- CreateTable
CREATE TABLE "GroupCollection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupCollectionEntry" (
    "id" TEXT NOT NULL,
    "groupJid" TEXT NOT NULL,
    "groupName" TEXT,
    "groupCollectionId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupCollectionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupCollection_userId_name_key" ON "GroupCollection"("userId", "name");

-- CreateIndex
CREATE INDEX "GroupCollection_userId_idx" ON "GroupCollection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupCollectionEntry_groupJid_groupCollectionId_key" ON "GroupCollectionEntry"("groupJid", "groupCollectionId");

-- CreateIndex
CREATE INDEX "GroupCollectionEntry_groupCollectionId_idx" ON "GroupCollectionEntry"("groupCollectionId");

-- AddForeignKey
ALTER TABLE "GroupCollection" ADD CONSTRAINT "GroupCollection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupCollectionEntry" ADD CONSTRAINT "GroupCollectionEntry_groupCollectionId_fkey" FOREIGN KEY ("groupCollectionId") REFERENCES "GroupCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

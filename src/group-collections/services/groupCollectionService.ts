import { prisma } from '../../shared/db';

export async function listGroupCollections(userId: string) {
  return prisma.groupCollection.findMany({
    where: { userId },
    include: { _count: { select: { entries: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createGroupCollection(userId: string, name: string, description?: string) {
  return prisma.groupCollection.create({
    data: { name, description: description || null, userId },
  });
}

export async function getGroupCollectionWithEntries(id: string, userId: string) {
  return prisma.groupCollection.findFirst({
    where: { id, userId },
    include: {
      entries: { orderBy: { addedAt: 'desc' } },
      _count: { select: { entries: true } },
    },
  });
}

export async function updateGroupCollection(
  id: string,
  userId: string,
  data: { name?: string; description?: string },
) {
  // Verify ownership
  const existing = await prisma.groupCollection.findFirst({ where: { id, userId } });
  if (!existing) return null;

  return prisma.groupCollection.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
    },
  });
}

export async function deleteGroupCollection(id: string, userId: string) {
  const existing = await prisma.groupCollection.findFirst({ where: { id, userId } });
  if (!existing) return null;

  return prisma.groupCollection.delete({ where: { id } });
}

export async function replaceGroupsInCollection(
  id: string,
  groups: Array<{ jid: string; name?: string }>,
) {
  await prisma.$transaction([
    prisma.groupCollectionEntry.deleteMany({ where: { groupCollectionId: id } }),
    prisma.groupCollectionEntry.createMany({
      data: groups.map((g) => ({
        groupJid: g.jid,
        groupName: g.name || null,
        groupCollectionId: id,
      })),
      skipDuplicates: true,
    }),
  ]);
}

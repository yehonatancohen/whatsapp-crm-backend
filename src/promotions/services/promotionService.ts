import { prisma } from '../../shared/db';

// ─── Types ──────────────────────────────────────────────────────────

interface CreatePromotionData {
  name: string;
  sendTimes: string[];
  daysOfWeek?: number[];
  timezone?: string;
  accountIds: string[];
  dailyLimitPerAccount?: number;
  messagesPerMinute?: number;
  groups: { jid: string; name?: string }[];
  messages: { content: string; mediaUrl?: string }[];
}

interface UpdatePromotionData {
  name?: string;
  sendTimes?: string[];
  daysOfWeek?: number[];
  timezone?: string;
  accountIds?: string[];
  dailyLimitPerAccount?: number;
  messagesPerMinute?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

async function getOwned(promotionId: string, userId: string, role: string) {
  const promotion = await prisma.groupPromotion.findUnique({
    where: { id: promotionId },
    include: { messages: true, groups: true },
  });
  if (!promotion) throw Object.assign(new Error('Promotion not found'), { status: 404 });
  if (role !== 'ADMIN' && promotion.userId !== userId) {
    throw Object.assign(new Error('Not authorized'), { status: 403 });
  }
  return promotion;
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function createPromotion(userId: string, data: CreatePromotionData) {
  return prisma.$transaction(async (tx) => {
    const promotion = await tx.groupPromotion.create({
      data: {
        name: data.name,
        sendTimes: data.sendTimes,
        daysOfWeek: data.daysOfWeek || [],
        timezone: data.timezone || 'Asia/Jerusalem',
        accountIds: data.accountIds,
        dailyLimitPerAccount: data.dailyLimitPerAccount || 50,
        messagesPerMinute: data.messagesPerMinute || 2,
        userId,
      },
    });

    if (data.messages.length > 0) {
      await tx.groupPromotionMessage.createMany({
        data: data.messages.map((m) => ({
          content: m.content,
          mediaUrl: m.mediaUrl || null,
          promotionId: promotion.id,
        })),
      });
    }

    if (data.groups.length > 0) {
      await tx.groupPromotionGroup.createMany({
        data: data.groups.map((g) => ({
          groupJid: g.jid,
          groupName: g.name || null,
          promotionId: promotion.id,
        })),
      });
    }

    return tx.groupPromotion.findUnique({
      where: { id: promotion.id },
      include: { messages: true, groups: true },
    });
  });
}

export async function listPromotions(userId: string, role: string) {
  return prisma.groupPromotion.findMany({
    where: role === 'ADMIN' ? {} : { userId },
    include: {
      messages: true,
      groups: true,
      _count: { select: { logs: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getPromotion(promotionId: string, userId: string, role: string) {
  return getOwned(promotionId, userId, role);
}

export async function updatePromotion(
  promotionId: string,
  userId: string,
  role: string,
  data: UpdatePromotionData,
) {
  await getOwned(promotionId, userId, role);
  return prisma.groupPromotion.update({
    where: { id: promotionId },
    data,
    include: { messages: true, groups: true },
  });
}

export async function deletePromotion(promotionId: string, userId: string, role: string) {
  await getOwned(promotionId, userId, role);
  await prisma.groupPromotion.delete({ where: { id: promotionId } });
}

export async function togglePromotion(promotionId: string, userId: string, role: string) {
  const promotion = await getOwned(promotionId, userId, role);
  return prisma.groupPromotion.update({
    where: { id: promotionId },
    data: { isActive: !promotion.isActive },
    include: { messages: true, groups: true },
  });
}

// ─── Message Pool ───────────────────────────────────────────────────

export async function addMessage(
  promotionId: string,
  userId: string,
  role: string,
  data: { content: string; mediaUrl?: string },
) {
  await getOwned(promotionId, userId, role);
  return prisma.groupPromotionMessage.create({
    data: {
      content: data.content,
      mediaUrl: data.mediaUrl || null,
      promotionId,
    },
  });
}

export async function updateMessage(
  messageId: string,
  userId: string,
  role: string,
  data: { content?: string; mediaUrl?: string | null; isActive?: boolean },
) {
  const msg = await prisma.groupPromotionMessage.findUnique({
    where: { id: messageId },
    include: { promotion: { select: { userId: true } } },
  });
  if (!msg) throw Object.assign(new Error('Message not found'), { status: 404 });
  if (role !== 'ADMIN' && msg.promotion.userId !== userId) {
    throw Object.assign(new Error('Not authorized'), { status: 403 });
  }
  return prisma.groupPromotionMessage.update({ where: { id: messageId }, data });
}

export async function removeMessage(messageId: string, userId: string, role: string) {
  const msg = await prisma.groupPromotionMessage.findUnique({
    where: { id: messageId },
    include: { promotion: { select: { userId: true } } },
  });
  if (!msg) throw Object.assign(new Error('Message not found'), { status: 404 });
  if (role !== 'ADMIN' && msg.promotion.userId !== userId) {
    throw Object.assign(new Error('Not authorized'), { status: 403 });
  }
  await prisma.groupPromotionMessage.delete({ where: { id: messageId } });
}

// ─── Groups ─────────────────────────────────────────────────────────

export async function updateGroups(
  promotionId: string,
  userId: string,
  role: string,
  groups: { jid: string; name?: string }[],
) {
  await getOwned(promotionId, userId, role);
  await prisma.$transaction([
    prisma.groupPromotionGroup.deleteMany({ where: { promotionId } }),
    prisma.groupPromotionGroup.createMany({
      data: groups.map((g) => ({
        groupJid: g.jid,
        groupName: g.name || null,
        promotionId,
      })),
    }),
  ]);
  return prisma.groupPromotion.findUnique({
    where: { id: promotionId },
    include: { messages: true, groups: true },
  });
}

// ─── Logs ───────────────────────────────────────────────────────────

export async function getPromotionLogs(
  promotionId: string,
  userId: string,
  role: string,
  limit = 50,
  offset = 0,
) {
  await getOwned(promotionId, userId, role);
  return prisma.groupPromotionLog.findMany({
    where: { promotionId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

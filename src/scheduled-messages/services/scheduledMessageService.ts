import { prisma } from '../../shared/db';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';

export interface CreateScheduledMessageData {
  chatId: string;
  chatName?: string;
  body: string;
  scheduledAt: string;
  accountId: string;
}

async function getOwnedMessage(id: string, userId: string) {
  const msg = await prisma.scheduledMessage.findUnique({ where: { id } });
  if (!msg) throw new NotFoundError('Scheduled message');
  if (msg.userId !== userId) throw new ForbiddenError('You do not own this message');
  return msg;
}

export async function listScheduledMessages(userId: string, accountId?: string) {
  const where: Record<string, unknown> = { userId };
  if (accountId) where.accountId = accountId;

  return prisma.scheduledMessage.findMany({
    where,
    orderBy: { scheduledAt: 'asc' },
    include: {
      account: { select: { id: true, label: true } },
    },
  });
}

export async function createScheduledMessage(userId: string, data: CreateScheduledMessageData) {
  const scheduledAt = new Date(data.scheduledAt);
  if (scheduledAt <= new Date()) {
    throw new ValidationError('Scheduled time must be in the future');
  }

  // Verify account ownership
  const account = await prisma.account.findUnique({ where: { id: data.accountId } });
  if (!account) throw new NotFoundError('Account');
  if (account.userId !== userId) throw new ForbiddenError('You do not own this account');

  return prisma.scheduledMessage.create({
    data: {
      chatId: data.chatId,
      chatName: data.chatName || null,
      body: data.body,
      scheduledAt,
      accountId: data.accountId,
      userId,
    },
    include: {
      account: { select: { id: true, label: true } },
    },
  });
}

export async function cancelScheduledMessage(id: string, userId: string) {
  const msg = await getOwnedMessage(id, userId);
  if (msg.status !== 'PENDING') {
    throw new ValidationError('Only pending messages can be cancelled');
  }
  return prisma.scheduledMessage.update({
    where: { id },
    data: { status: 'CANCELLED' },
  });
}

export async function deleteScheduledMessage(id: string, userId: string) {
  const msg = await getOwnedMessage(id, userId);
  if (msg.status === 'PENDING') {
    throw new ValidationError('Cancel the message before deleting');
  }
  await prisma.scheduledMessage.delete({ where: { id } });
}

/**
 * Called by the scheduler worker. Finds and sends all due messages.
 */
export async function processDueMessages(
  sendFn: (accountId: string, chatId: string, body: string) => Promise<void>,
) {
  const now = new Date();
  const dueMessages = await prisma.scheduledMessage.findMany({
    where: {
      status: 'PENDING',
      scheduledAt: { lte: now },
    },
    orderBy: { scheduledAt: 'asc' },
    take: 50,
  });

  for (const msg of dueMessages) {
    try {
      await sendFn(msg.accountId, msg.chatId, msg.body);
      await prisma.scheduledMessage.update({
        where: { id: msg.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
      logger.info({ id: msg.id, chatId: msg.chatId }, 'Scheduled message sent');
    } catch (err: any) {
      await prisma.scheduledMessage.update({
        where: { id: msg.id },
        data: { status: 'FAILED', errorMessage: err?.message || 'Send failed' },
      });
      logger.error({ id: msg.id, err }, 'Failed to send scheduled message');
    }
  }

  return dueMessages.length;
}

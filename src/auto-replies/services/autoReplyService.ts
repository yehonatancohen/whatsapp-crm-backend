import { AutoReplyMatchType } from '@prisma/client';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';

export interface CreateAutoReplyData {
  name: string;
  matchType?: AutoReplyMatchType;
  matchValue: string;
  replyMessage: string;
  accountIds?: string[];
  onlyPrivate?: boolean;
  cooldownSec?: number;
}

export interface UpdateAutoReplyData {
  name?: string;
  isActive?: boolean;
  matchType?: AutoReplyMatchType;
  matchValue?: string;
  replyMessage?: string;
  accountIds?: string[];
  onlyPrivate?: boolean;
  cooldownSec?: number;
}

async function getOwnedRule(id: string, userId: string) {
  const rule = await prisma.autoReply.findUnique({ where: { id } });
  if (!rule) throw new NotFoundError('Auto-reply rule');
  if (rule.userId !== userId) throw new ForbiddenError('You do not own this rule');
  return rule;
}

export async function listAutoReplies(userId: string) {
  return prisma.autoReply.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getAutoReply(id: string, userId: string) {
  return getOwnedRule(id, userId);
}

export async function createAutoReply(userId: string, data: CreateAutoReplyData) {
  return prisma.autoReply.create({
    data: {
      name: data.name,
      matchType: data.matchType || 'CONTAINS',
      matchValue: data.matchValue,
      replyMessage: data.replyMessage,
      accountIds: data.accountIds || [],
      onlyPrivate: data.onlyPrivate ?? true,
      cooldownSec: data.cooldownSec ?? 60,
      userId,
    },
  });
}

export async function updateAutoReply(id: string, userId: string, data: UpdateAutoReplyData) {
  await getOwnedRule(id, userId);
  return prisma.autoReply.update({ where: { id }, data });
}

export async function deleteAutoReply(id: string, userId: string) {
  await getOwnedRule(id, userId);
  await prisma.autoReply.delete({ where: { id } });
}

export async function toggleAutoReply(id: string, userId: string) {
  const rule = await getOwnedRule(id, userId);
  return prisma.autoReply.update({
    where: { id },
    data: { isActive: !rule.isActive },
  });
}

// ─── Message matching engine ────────────────────────────────────────

/** In-memory cooldown tracker: Map<"ruleId:chatId" → lastTriggerTimestamp> */
const cooldownMap = new Map<string, number>();

function matchesRule(message: string, matchType: AutoReplyMatchType, matchValue: string): boolean {
  const msg = message.toLowerCase();
  const val = matchValue.toLowerCase();

  switch (matchType) {
    case 'EXACT':
      return msg === val;
    case 'CONTAINS':
      return msg.includes(val);
    case 'STARTS_WITH':
      return msg.startsWith(val);
    case 'REGEX':
      try {
        return new RegExp(matchValue, 'i').test(message);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * Process an incoming message against all active auto-reply rules for a user.
 * Returns the reply message if a rule matched, or null.
 */
export async function processIncomingMessage(
  userId: string,
  accountId: string,
  chatId: string,
  messageBody: string,
  isGroup: boolean,
): Promise<string | null> {
  const rules = await prisma.autoReply.findMany({
    where: { userId, isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const rule of rules) {
    // Skip if rule is private-only and this is a group
    if (rule.onlyPrivate && isGroup) continue;

    // Skip if rule is bound to specific accounts and this account isn't in the list
    if (rule.accountIds.length > 0 && !rule.accountIds.includes(accountId)) continue;

    // Check cooldown
    const cooldownKey = `${rule.id}:${chatId}`;
    const lastTrigger = cooldownMap.get(cooldownKey) || 0;
    const now = Date.now();
    if (now - lastTrigger < rule.cooldownSec * 1000) continue;

    // Check match
    if (!matchesRule(messageBody, rule.matchType, rule.matchValue)) continue;

    // Match found!
    cooldownMap.set(cooldownKey, now);

    // Increment trigger count
    await prisma.autoReply.update({
      where: { id: rule.id },
      data: { triggerCount: { increment: 1 } },
    });

    logger.info({ ruleId: rule.id, ruleName: rule.name, chatId }, 'Auto-reply triggered');
    return rule.replyMessage;
  }

  return null;
}

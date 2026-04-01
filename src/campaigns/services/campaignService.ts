import { CampaignStatus, CampaignType } from '@prisma/client';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';
import { emitToUser } from '../../shared/socket';
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
} from '../../shared/errors';
import { campaignProcessQueue } from '../campaignQueue';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateCampaignData {
  name: string;
  messageTemplate: string;
  type?: CampaignType;
  contactListId?: string;
  scheduledAt?: string;
  messagesPerMinute?: number;
  dailyLimitPerAccount?: number;
  groupJids?: { jid: string; name?: string }[];
  accountIds: string[];
}

export interface UpdateCampaignData {
  name?: string;
  messageTemplate?: string;
  type?: CampaignType;
  contactListId?: string;
  scheduledAt?: string;
  messagesPerMinute?: number;
  dailyLimitPerAccount?: number;
}

export interface CampaignProgress {
  total: number;
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Verify campaign exists and belongs to user. Returns the campaign. */
async function getOwnedCampaign(campaignId: string, userId: string, _role: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new NotFoundError('Campaign');
  if (campaign.userId !== userId) {
    throw new ForbiddenError('You do not own this campaign');
  }
  return campaign;
}

// ─── Service Functions ────────────────────────────────────────────────────────

/** Create a new campaign in DRAFT status. */
export async function createCampaign(
  userId: string,
  data: CreateCampaignData,
) {
  // Validate contact list ownership if provided
  if (data.contactListId) {
    const contactList = await prisma.contactList.findUnique({
      where: { id: data.contactListId },
    });
    if (!contactList) throw new NotFoundError('Contact list');
    if (contactList.userId !== userId) {
      throw new ForbiddenError('You do not own this contact list');
    }
  }

  const campaign = await prisma.campaign.create({
    data: {
      name: data.name,
      messageTemplate: data.messageTemplate,
      type: data.type || 'DIRECT_MESSAGE',
      status: 'DRAFT',
      contactListId: data.contactListId || null,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
      messagesPerMinute: data.messagesPerMinute ?? 2,
      dailyLimitPerAccount: data.dailyLimitPerAccount ?? 50,
      accountIds: data.accountIds,
      userId,
    },
  });

  if (data.groupJids && data.groupJids.length > 0) {
    await prisma.campaignGroup.createMany({
      data: data.groupJids.map((g: { jid: string; name?: string }) => ({
        campaignId: campaign.id,
        groupJid: g.jid,
        groupName: g.name || null,
      })),
    });
  }

  await prisma.activityLog.create({
    data: {
      type: 'CAMPAIGN_CREATED',
      message: `Campaign "${campaign.name}" created`,
      userId,
    },
  });

  logger.info({ campaignId: campaign.id, name: campaign.name }, 'Campaign created');
  return campaign;
}

/** Get a single campaign with message stats. */
export async function getCampaign(campaignId: string, userId: string, role: string) {
  const campaign = await getOwnedCampaign(campaignId, userId, role);

  // Get message status breakdown
  const messageCounts = await prisma.campaignMessage.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { id: true },
  });

  const statusBreakdown: Record<string, number> = {};
  for (const mc of messageCounts) {
    statusBreakdown[mc.status] = mc._count.id;
  }

  return {
    ...campaign,
    messageStats: statusBreakdown,
  };
}

/** List campaigns for a user, optionally filtered by status. */
export async function listCampaigns(userId: string, _role: string, status?: CampaignStatus) {
  const where: Record<string, unknown> = { userId };

  if (status) {
    where.status = status;
  }

  const campaigns = await prisma.campaign.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      contactList: { select: { id: true, name: true } },
      _count: { select: { messages: true } },
    },
  });

  return campaigns;
}

/** Update a DRAFT campaign. */
export async function updateCampaign(
  campaignId: string,
  userId: string,
  role: string,
  data: UpdateCampaignData,
) {
  const campaign = await getOwnedCampaign(campaignId, userId, role);

  if (campaign.status !== 'DRAFT') {
    throw new ConflictError('Only DRAFT campaigns can be updated');
  }

  // Validate contact list ownership if changing it
  if (data.contactListId) {
    const contactList = await prisma.contactList.findUnique({
      where: { id: data.contactListId },
    });
    if (!contactList) throw new NotFoundError('Contact list');
    if (contactList.userId !== campaign.userId) {
      throw new ForbiddenError('You do not own this contact list');
    }
  }

  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      name: data.name,
      messageTemplate: data.messageTemplate,
      type: data.type,
      contactListId: data.contactListId,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
      messagesPerMinute: data.messagesPerMinute,
      dailyLimitPerAccount: data.dailyLimitPerAccount,
    },
  });

  logger.info({ campaignId }, 'Campaign updated');
  return updated;
}

/** Delete a campaign. Only DRAFT, COMPLETED, CANCELLED, or FAILED campaigns can be deleted. */
export async function deleteCampaign(campaignId: string, userId: string, role: string) {
  const campaign = await getOwnedCampaign(campaignId, userId, role);

  const deletableStatuses: CampaignStatus[] = ['DRAFT', 'COMPLETED', 'CANCELLED', 'FAILED'];
  if (!deletableStatuses.includes(campaign.status)) {
    throw new ConflictError(
      `Cannot delete campaign with status ${campaign.status}. Only DRAFT, COMPLETED, CANCELLED, or FAILED campaigns can be deleted`,
    );
  }

  await prisma.campaign.delete({ where: { id: campaignId } });
  logger.info({ campaignId }, 'Campaign deleted');
}

/** Start a DRAFT campaign: create messages, enqueue processing. */
export async function startCampaign(campaignId: string, userId: string, role: string) {
  const campaign = await getOwnedCampaign(campaignId, userId, role);

  if (campaign.status !== 'DRAFT') {
    throw new ConflictError('Only DRAFT campaigns can be started');
  }

  let totalMessages: number;

  if (campaign.type === 'GROUP_MESSAGE') {
    // For GROUP_MESSAGE campaigns, create messages from campaign groups
    const groups = await prisma.campaignGroup.findMany({
      where: { campaignId },
    });

    if (groups.length === 0) {
      throw new ValidationError('Campaign has no target groups');
    }

    const messageData = groups.map((group) => ({
      campaignId,
      groupJid: group.groupJid,
      status: 'PENDING' as const,
    }));

    await prisma.campaignMessage.createMany({ data: messageData });
    totalMessages = groups.length;
  } else {
    // For DIRECT_MESSAGE campaigns, create messages from contact list
    if (!campaign.contactListId) {
      throw new ValidationError('Campaign must have a contact list before starting');
    }

    // Get contacts from the contact list
    const entries = await prisma.contactListEntry.findMany({
      where: { contactListId: campaign.contactListId },
      select: { contactId: true },
    });

    if (entries.length === 0) {
      throw new ValidationError('Contact list is empty');
    }

    // Create CampaignMessage records for each contact
    const messageData = entries.map((entry) => ({
      campaignId,
      contactId: entry.contactId,
      status: 'PENDING' as const,
    }));

    await prisma.campaignMessage.createMany({ data: messageData });
    totalMessages = entries.length;
  }

  // Update campaign status
  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
      totalMessages,
    },
  });

  // Add the first processing job
  await campaignProcessQueue.add(
    'process-message',
    { campaignId },
    { jobId: `campaign-${campaignId}-${Date.now()}` },
  );

  // Log activity
  await prisma.activityLog.create({
    data: {
      type: 'CAMPAIGN_STARTED',
      message: `Campaign "${campaign.name}" started with ${totalMessages} messages`,
      userId: campaign.userId,
    },
  });

  // Emit socket event
  emitToUser(campaign.userId, 'campaign:status', {
    campaignId,
    status: 'RUNNING',
    totalMessages,
  });

  logger.info({ campaignId, totalMessages }, 'Campaign started');
  return updated;
}

/** Pause a RUNNING campaign. */
export async function pauseCampaign(campaignId: string, userId: string, role: string) {
  const campaign = await getOwnedCampaign(campaignId, userId, role);

  if (campaign.status !== 'RUNNING') {
    throw new ConflictError('Only RUNNING campaigns can be paused');
  }

  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'PAUSED' },
  });

  await prisma.activityLog.create({
    data: {
      type: 'CAMPAIGN_PAUSED',
      message: `Campaign "${campaign.name}" paused`,
      userId: campaign.userId,
    },
  });

  emitToUser(campaign.userId, 'campaign:status', {
    campaignId,
    status: 'PAUSED',
  });

  logger.info({ campaignId }, 'Campaign paused');
  return updated;
}

/** Resume a PAUSED campaign. */
export async function resumeCampaign(campaignId: string, userId: string, role: string) {
  const campaign = await getOwnedCampaign(campaignId, userId, role);

  if (campaign.status !== 'PAUSED') {
    throw new ConflictError('Only PAUSED campaigns can be resumed');
  }

  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'RUNNING' },
  });

  // Re-add processing job to continue
  await campaignProcessQueue.add(
    'process-message',
    { campaignId },
    { jobId: `campaign-${campaignId}-${Date.now()}` },
  );

  emitToUser(campaign.userId, 'campaign:status', {
    campaignId,
    status: 'RUNNING',
  });

  logger.info({ campaignId }, 'Campaign resumed');
  return updated;
}

/** Cancel a RUNNING or PAUSED campaign. */
export async function cancelCampaign(campaignId: string, userId: string, role: string) {
  const campaign = await getOwnedCampaign(campaignId, userId, role);

  if (campaign.status !== 'RUNNING' && campaign.status !== 'PAUSED') {
    throw new ConflictError('Only RUNNING or PAUSED campaigns can be cancelled');
  }

  // Mark all pending/queued messages as FAILED
  const cancelledMessages = await prisma.campaignMessage.updateMany({
    where: {
      campaignId,
      status: { in: ['PENDING', 'QUEUED'] },
    },
    data: {
      status: 'FAILED',
      errorMessage: 'Campaign cancelled',
    },
  });

  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: 'CANCELLED',
      completedAt: new Date(),
      failedCount: { increment: cancelledMessages.count },
    },
  });

  await prisma.activityLog.create({
    data: {
      type: 'CAMPAIGN_CANCELLED',
      message: `Campaign "${campaign.name}" cancelled (${cancelledMessages.count} messages cancelled)`,
      userId: campaign.userId,
    },
  });

  emitToUser(campaign.userId, 'campaign:status', {
    campaignId,
    status: 'CANCELLED',
  });

  logger.info({ campaignId, cancelledMessages: cancelledMessages.count }, 'Campaign cancelled');
  return updated;
}

/** Restart a completed/cancelled/failed campaign from the beginning. */
export async function restartCampaign(campaignId: string, userId: string, role: string) {
  const campaign = await getOwnedCampaign(campaignId, userId, role);

  const restartableStatuses: CampaignStatus[] = ['COMPLETED', 'CANCELLED', 'FAILED'];
  if (!restartableStatuses.includes(campaign.status)) {
    throw new ConflictError('Only COMPLETED, CANCELLED, or FAILED campaigns can be restarted');
  }

  // Delete all existing messages so they are recreated fresh
  await prisma.campaignMessage.deleteMany({ where: { campaignId } });

  // Reset campaign counters and status back to DRAFT
  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: 'DRAFT',
      sentCount: 0,
      failedCount: 0,
      totalMessages: 0,
      startedAt: null,
      completedAt: null,
    },
  });

  await prisma.activityLog.create({
    data: {
      type: 'CAMPAIGN_CREATED',
      message: `Campaign "${campaign.name}" restarted`,
      userId: campaign.userId,
    },
  });

  emitToUser(campaign.userId, 'campaign:status', {
    campaignId,
    status: 'DRAFT',
  });

  logger.info({ campaignId }, 'Campaign restarted');
  return updated;
}

/** Get failed messages for a campaign with their error reasons. */
export async function getCampaignFailures(
  campaignId: string,
  userId: string,
  role: string,
  limit = 50,
) {
  await getOwnedCampaign(campaignId, userId, role);

  const failures = await prisma.campaignMessage.findMany({
    where: {
      campaignId,
      status: 'FAILED',
    },
    select: {
      id: true,
      errorMessage: true,
      contact: {
        select: { phoneNumber: true, name: true },
      },
      groupJid: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return failures;
}

/** Get campaign progress stats. */
export async function getCampaignProgress(campaignId: string): Promise<CampaignProgress> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
  });

  if (!campaign) throw new NotFoundError('Campaign');

  const messageCounts = await prisma.campaignMessage.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { id: true },
  });

  const countMap = new Map<string, number>();
  for (const mc of messageCounts) {
    countMap.set(mc.status, mc._count.id);
  }

  return {
    total: campaign.totalMessages,
    sent: (countMap.get('SENT') || 0) + (countMap.get('DELIVERED') || 0),
    delivered: countMap.get('DELIVERED') || 0,
    failed: countMap.get('FAILED') || 0,
    pending: (countMap.get('PENDING') || 0) + (countMap.get('QUEUED') || 0) + (countMap.get('SENDING') || 0),
  };
}

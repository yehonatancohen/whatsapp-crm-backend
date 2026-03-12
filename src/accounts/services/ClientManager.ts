import { AccountStatus as PrismaAccountStatus } from '@prisma/client';
import { WhatsAppInstance, AccountEventHandlers, AccountStatusType, ChatMessageEvent } from './WhatsAppInstance';
import { prisma } from '../../shared/db';
import { emitToUser, emitToAdmins } from '../../shared/socket';
import { logger } from '../../shared/logger';
import { ConflictError, NotFoundError } from '../../shared/errors';

// Map our status strings to Prisma enum
const statusToPrisma: Record<AccountStatusType, PrismaAccountStatus> = {
  INITIALIZING: 'INITIALIZING',
  QR_READY: 'QR_READY',
  AUTHENTICATED: 'AUTHENTICATED',
  DISCONNECTED: 'DISCONNECTED',
};

export class ClientManager {
  private static instance: ClientManager;
  private instances: Map<string, WhatsAppInstance> = new Map();

  private constructor() {}

  static getInstance(): ClientManager {
    if (!ClientManager.instance) {
      ClientManager.instance = new ClientManager();
    }
    return ClientManager.instance;
  }

  async addAccount(userId: string, label: string, proxy?: string) {
    // Check for duplicate label for this user
    const existing = await prisma.account.findUnique({
      where: { userId_label: { userId, label } },
    });
    if (existing) {
      throw new ConflictError(`Account "${label}" already exists`);
    }

    // Create DB record
    const account = await prisma.account.create({
      data: {
        label,
        proxy: proxy || null,
        userId,
        status: 'INITIALIZING',
      },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        type: 'ACCOUNT_CREATED',
        message: `Account "${label}" created`,
        userId,
        accountId: account.id,
      },
    });

    // Create event handlers that persist to DB + emit Socket.IO
    const eventHandlers: AccountEventHandlers = {
      onStatusChange: (id, status, error) => this.handleStatusChange(id, userId, status, error),
      onQr: (id, qrCode) => emitToUser(userId, 'account:qr', { id, qrCode }),
      onAuthenticated: (id, phoneNumber, pushName) =>
        this.handleAuthenticated(id, userId, phoneNumber, pushName),
      onMessage: (msg) => emitToUser(userId, 'chat:message', msg),
    };

    // Create and start the WhatsApp instance
    const instance = new WhatsAppInstance(account.id, label, proxy, eventHandlers);
    this.instances.set(account.id, instance);

    // Fire-and-forget initialization
    instance.initialize().catch((err: unknown) => {
      logger.error({ accountId: account.id, err }, 'Background init error');
      instance.status = 'DISCONNECTED';
      instance.error = err instanceof Error ? err.message : 'Unknown init error';
    });

    // Emit creation event
    emitToUser(userId, 'account:status', {
      id: account.id,
      label,
      status: 'INITIALIZING',
    });

    return instance.toResponse();
  }

  private async handleStatusChange(
    accountId: string,
    userId: string,
    status: AccountStatusType,
    error?: string,
  ) {
    try {
      await prisma.account.update({
        where: { id: accountId },
        data: {
          status: statusToPrisma[status],
          errorMessage: error || null,
        },
      });

      const instance = this.instances.get(accountId);
      emitToUser(userId, 'account:status', {
        id: accountId,
        label: instance?.label,
        status,
        error,
      });
    } catch (err) {
      logger.error({ accountId, err }, 'Failed to persist status change');
    }
  }

  private async handleAuthenticated(
    accountId: string,
    userId: string,
    phoneNumber?: string,
    pushName?: string,
  ) {
    try {
      await prisma.account.update({
        where: { id: accountId },
        data: {
          status: 'AUTHENTICATED',
          phoneNumber: phoneNumber || null,
          pushName: pushName || null,
          errorMessage: null,
        },
      });

      if (phoneNumber) {
        const exists = await prisma.warmupProgress.findUnique({ where: { phoneNumber } });
        if (!exists) {
          await prisma.warmupProgress.create({ data: { phoneNumber } });
        }
      }

      await prisma.activityLog.create({
        data: {
          type: 'ACCOUNT_CONNECTED',
          message: `Account connected: ${phoneNumber || accountId}`,
          userId,
          accountId,
        },
      });

      emitToUser(userId, 'account:authenticated', {
        id: accountId,
        phoneNumber,
        pushName,
      });
    } catch (err) {
      logger.error({ accountId, err }, 'Failed to persist authentication');
    }
  }

  async getAccount(accountId: string, userId?: string) {
    const instance = this.instances.get(accountId);
    if (instance) return instance.toResponse();

    // Fall back to DB if not in memory (e.g. after restart)
    const where: any = { id: accountId };
    if (userId) where.userId = userId;

    const dbAccount = await prisma.account.findFirst({ where });
    if (!dbAccount) return null;

    return {
      id: dbAccount.id,
      label: dbAccount.label,
      status: dbAccount.status as AccountStatusType,
      qrCode: null,
      error: dbAccount.errorMessage,
      phoneNumber: dbAccount.phoneNumber || undefined,
      pushName: dbAccount.pushName || undefined,
    };
  }

  async getAllAccounts(userId?: string, isAdmin = false) {
    const where = isAdmin ? {} : { userId };
    const dbAccounts = await prisma.account.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(
      dbAccounts.map(async (acc) => {
        const instance = this.instances.get(acc.id);
        
        let warmupLevel = 'L1';
        if (acc.phoneNumber) {
          const progress = await prisma.warmupProgress.findUnique({
            where: { phoneNumber: acc.phoneNumber },
          });
          if (progress) warmupLevel = progress.warmupLevel;
        }

        if (instance) {
          const res = instance.toResponse() as any;
          res.warmupLevel = warmupLevel;
          res.isWarmupEnabled = acc.isWarmupEnabled;
          return res;
        }

        return {
          id: acc.id,
          label: acc.label,
          status: acc.status as AccountStatusType,
          qrCode: null,
          error: acc.errorMessage,
          phoneNumber: acc.phoneNumber || undefined,
          pushName: acc.pushName || undefined,
          warmupLevel,
          isWarmupEnabled: acc.isWarmupEnabled,
        };
      })
    );
  }

  getAuthenticatedInstances(): WhatsAppInstance[] {
    return Array.from(this.instances.values()).filter(
      (inst) => inst.status === 'AUTHENTICATED',
    );
  }

  getInstanceById(accountId: string): WhatsAppInstance | undefined {
    return this.instances.get(accountId);
  }

  getAllInstances(): WhatsAppInstance[] {
    return Array.from(this.instances.values());
  }

  async removeAccount(accountId: string, userId?: string): Promise<boolean> {
    // Verify ownership
    const account = await prisma.account.findFirst({
      where: userId ? { id: accountId, userId } : { id: accountId },
    });
    if (!account) return false;

    // Destroy the live instance
    const instance = this.instances.get(accountId);
    if (instance) {
      await instance.destroy();
      this.instances.delete(accountId);
    }

    // Delete from DB (cascades to warmup logs, etc.)
    await prisma.account.delete({ where: { id: accountId } });

    await prisma.activityLog.create({
      data: {
        type: 'ACCOUNT_DELETED',
        message: `Account "${account.label}" deleted`,
        userId: account.userId,
      },
    });

    emitToUser(account.userId, 'account:status', {
      id: accountId,
      label: account.label,
      status: 'DISCONNECTED',
      deleted: true,
    });

    return true;
  }

  async reconnectAccount(accountId: string, userId: string) {
    const account = await prisma.account.findFirst({
      where: { id: accountId, userId },
    });
    if (!account) throw new NotFoundError('Account');

    // Destroy existing instance
    const existing = this.instances.get(accountId);
    if (existing) {
      await existing.destroy();
      this.instances.delete(accountId);
    }

    // Re-create
    const eventHandlers: AccountEventHandlers = {
      onStatusChange: (id, status, error) => this.handleStatusChange(id, userId, status, error),
      onQr: (id, qrCode) => emitToUser(userId, 'account:qr', { id, qrCode }),
      onAuthenticated: (id, phoneNumber, pushName) =>
        this.handleAuthenticated(id, userId, phoneNumber, pushName),
      onMessage: (msg) => emitToUser(userId, 'chat:message', msg),
    };

    const instance = new WhatsAppInstance(accountId, account.label, account.proxy || undefined, eventHandlers);
    this.instances.set(accountId, instance);

    await prisma.account.update({
      where: { id: accountId },
      data: { status: 'INITIALIZING', errorMessage: null },
    });

    instance.initialize().catch((err: unknown) => {
      logger.error({ accountId, err }, 'Reconnect error');
    });

    return instance.toResponse();
  }

  /** Restore accounts from DB on startup (re-initialize authenticated ones) */
  async restoreFromDB(): Promise<void> {
    const accounts = await prisma.account.findMany({
      where: { status: { not: 'DISCONNECTED' } },
      include: { user: { select: { id: true } } },
    });

    for (const account of accounts) {
      const userId = account.user.id;
      const eventHandlers: AccountEventHandlers = {
        onStatusChange: (id, status, error) => this.handleStatusChange(id, userId, status, error),
        onQr: (id, qrCode) => emitToUser(userId, 'account:qr', { id, qrCode }),
        onAuthenticated: (id, phoneNumber, pushName) =>
          this.handleAuthenticated(id, userId, phoneNumber, pushName),
        onMessage: (msg) => emitToUser(userId, 'chat:message', msg),
      };

      const instance = new WhatsAppInstance(account.id, account.label, account.proxy || undefined, eventHandlers);
      this.instances.set(account.id, instance);

      logger.info({ accountId: account.id, label: account.label }, 'Restoring account from DB');

      instance.initialize().catch((err: unknown) => {
        logger.error({ accountId: account.id, err }, 'Restore init error');
      });
    }
  }
}

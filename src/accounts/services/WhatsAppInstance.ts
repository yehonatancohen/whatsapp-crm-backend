import path from 'path';
import { Client, LocalAuth } from 'whatsapp-web.js';
import type { Browser } from 'puppeteer';
import { AccountStatus as PrismaAccountStatus } from '@prisma/client';
import { launchStealthBrowser } from './BrowserLauncher';
import { logger } from '../../shared/logger';

export type AccountStatusType = 'INITIALIZING' | 'QR_READY' | 'AUTHENTICATED' | 'DISCONNECTED';

export interface ChatMessageEvent {
  accountId: string;
  accountLabel: string;
  chatId: string;
  messageId: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  type: string;
  author?: string;
  chatName?: string;
  isGroup: boolean;
}

export interface AccountEventHandlers {
  onStatusChange: (id: string, status: AccountStatusType, error?: string) => void;
  onQr: (id: string, qrCode: string) => void;
  onAuthenticated: (id: string, phoneNumber?: string, pushName?: string) => void;
  onMessage?: (msg: ChatMessageEvent) => void;
}

export class WhatsAppInstance {
  public id: string;        // DB id (cuid)
  public label: string;
  public status: AccountStatusType;
  public qrCode: string | null = null;
  public error: string | null = null;

  private client: Client | null = null;
  private browser: Browser | null = null;
  private proxy?: string;
  private eventHandlers?: AccountEventHandlers;

  constructor(id: string, label: string, proxy?: string, eventHandlers?: AccountEventHandlers) {
    this.id = id;
    this.label = label;
    this.proxy = proxy;
    this.status = 'INITIALIZING';
    this.eventHandlers = eventHandlers;
  }

  async initialize(): Promise<void> {
    try {
      // Use the same session directory that LocalAuth expects so the browser
      // stores its profile data (IndexedDB, cookies) in the persistent volume.
      const sessionDir = path.resolve('.wwebjs_auth', `session-${this.label}`);
      this.browser = await launchStealthBrowser(this.proxy, sessionDir);
      const wsEndpoint = this.browser.wsEndpoint();

      this.client = new Client({
        authStrategy: new LocalAuth({ clientId: this.label }),
        puppeteer: {
          browserWSEndpoint: wsEndpoint,
        },
      });

      this.attachEventHandlers();
      await this.client.initialize();
    } catch (err: unknown) {
      this.setStatus('DISCONNECTED', err instanceof Error ? err.message : 'Failed to initialize');
      logger.error({ instanceId: this.id, err }, 'Initialization error');
    }
  }

  private setStatus(status: AccountStatusType, error?: string): void {
    this.status = status;
    this.error = error || null;
    this.eventHandlers?.onStatusChange(this.id, status, error);
  }

  private attachEventHandlers(): void {
    if (!this.client) return;

    this.client.on('qr', (qr: string) => {
      try {
        logger.info({ instanceId: this.id }, 'QR code received');
        this.qrCode = qr;
        this.setStatus('QR_READY');
        this.eventHandlers?.onQr(this.id, qr);
      } catch (err: unknown) {
        this.error = err instanceof Error ? err.message : 'QR handler error';
      }
    });

    this.client.on('authenticated', () => {
      try {
        logger.info({ instanceId: this.id }, 'Authenticated');
        this.setStatus('AUTHENTICATED');
        this.qrCode = null;
      } catch (err: unknown) {
        this.error = err instanceof Error ? err.message : 'Auth handler error';
      }
    });

    this.client.on('ready', () => {
      try {
        logger.info({ instanceId: this.id }, 'Client ready');
        this.setStatus('AUTHENTICATED');
        this.qrCode = null;
        const phoneNumber = this.client?.info?.wid?.user;
        const pushName = this.client?.info?.pushname;
        this.eventHandlers?.onAuthenticated(this.id, phoneNumber, pushName);
      } catch (err: unknown) {
        this.error = err instanceof Error ? err.message : 'Ready handler error';
      }
    });

    this.client.on('disconnected', (reason: string) => {
      try {
        logger.info({ instanceId: this.id, reason }, 'Disconnected');
        this.setStatus('DISCONNECTED', reason);
        this.qrCode = null;
      } catch (err: unknown) {
        this.error = err instanceof Error ? err.message : 'Disconnect handler error';
      }
    });

    this.client.on('auth_failure', (msg: string) => {
      try {
        logger.warn({ instanceId: this.id, msg }, 'Auth failure');
        this.setStatus('DISCONNECTED', `Auth failure: ${msg}`);
      } catch (err: unknown) {
        this.error = err instanceof Error ? err.message : 'Auth failure handler error';
      }
    });

    // Chat message events — fires for both incoming and outgoing messages
    this.client.on('message_create', async (msg) => {
      try {
        if (!this.eventHandlers?.onMessage) return;
        const chat = await msg.getChat();
        this.eventHandlers.onMessage({
          accountId: this.id,
          accountLabel: this.label,
          chatId: chat.id._serialized,
          messageId: msg.id._serialized,
          body: msg.body,
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          type: msg.type,
          author: msg.author || undefined,
          chatName: chat.name || chat.id.user,
          isGroup: chat.isGroup,
        });
      } catch (err) {
        logger.debug({ instanceId: this.id, err }, 'message_create handler error');
      }
    });
  }

  async getGroups(): Promise<Array<{ id: string; name: string; participantsCount: number }>> {
    if (!this.client || this.status !== 'AUTHENTICATED') return [];

    const chats = await this.client.getChats();
    return chats
      .filter((chat) => chat.isGroup)
      .map((chat) => ({
        id: chat.id._serialized,
        name: chat.name,
        participantsCount: (chat as any).participants?.length ?? 0,
      }));
  }

  async destroy(): Promise<void> {
    try {
      if (this.client) await this.client.destroy();
    } catch {
      // Swallow — client may already be dead
    }
    try {
      if (this.browser) await this.browser.close();
    } catch {
      // Swallow — browser may already be closed
    }
    this.client = null;
    this.browser = null;
  }

  getClient(): Client | null {
    return this.client;
  }

  toResponse() {
    return {
      id: this.id,
      label: this.label,
      status: this.status,
      qrCode: this.qrCode,
      error: this.error,
      phoneNumber: this.client?.info?.wid?.user || undefined,
      pushName: this.client?.info?.pushname || undefined,
    };
  }
}
